import * as lark from '@larksuiteoapi/node-sdk';
import { feishuConfig, groupConfig } from '../config.js';
import { forwardPairing } from '../handlers/forward-pairing.js';
import { EventEmitter } from 'events';
import type { ReadStream } from 'fs';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROCESSED_IDS_PATH = join(__dirname, '../../logs/processed-message-ids.json');
const PROCESSED_ID_TTL_MS = 24 * 60 * 60 * 1000; // 24 小时
const SAVE_DEBOUNCE_MS = 500;

function loadProcessedIds(): Map<string, number> {
  try {
    const raw = readFileSync(PROCESSED_IDS_PATH, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    const now = Date.now();
    const map = new Map<string, number>();
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') {
          if (now - entry[1] < PROCESSED_ID_TTL_MS) {
            map.set(entry[0], entry[1]);
          }
        } else if (typeof entry === 'string') {
          map.set(entry, now);
        }
      }
    }
    return map;
  } catch {
    return new Map();
  }
}

let saveDebounceTimer: ReturnType<typeof setTimeout> | null = null;

function saveProcessedIds(ids: Map<string, number>): void {
  if (saveDebounceTimer) return;
  saveDebounceTimer = setTimeout(() => {
    saveDebounceTimer = null;
    try {
      mkdirSync(dirname(PROCESSED_IDS_PATH), { recursive: true });
      writeFileSync(PROCESSED_IDS_PATH, JSON.stringify(Array.from(ids.entries())));
    } catch (_) { void 0; }
  }, SAVE_DEBOUNCE_MS);
}

function formatError(error: unknown): { message: string; responseData?: unknown } {
  if (error instanceof Error) {
    const responseData = typeof error === 'object' && error !== null && 'response' in error
      ? (error as { response?: { data?: unknown } }).response?.data
      : undefined;
    return { message: `${error.name}: ${error.message}`, responseData };
  }

  const responseData = typeof error === 'object' && error !== null && 'response' in error
    ? (error as { response?: { data?: unknown } }).response?.data
    : undefined;

  let message = '';
  try {
    message = JSON.stringify(error);
  } catch {
    message = String(error);
  }

  return { message, responseData };
}

function extractApiCode(responseData: unknown): number | undefined {
  if (!responseData || typeof responseData !== 'object') return undefined;
  const value = (responseData as { code?: unknown }).code;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function stringifyErrorPayload(payload: unknown): string {
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

function isUniversalCardBuildFailure(responseData: unknown): boolean {
  const apiCode = extractApiCode(responseData);
  if (apiCode === 230099) {
    return true;
  }

  const text = stringifyErrorPayload(responseData).toLowerCase();
  return text.includes('230099')
    || text.includes('200800')
    || text.includes('create universal card fail');
}

function buildFallbackInteractiveCard(sourceCard: object): object {
  const cardRecord = sourceCard as {
    header?: {
      title?: { content?: unknown };
      template?: unknown;
    };
  };
  const rawTitle = cardRecord.header?.title?.content;
  const title = typeof rawTitle === 'string' && rawTitle.trim()
    ? rawTitle.trim().slice(0, 60)
    : 'OpenCode 输出（已精简）';
  const rawTemplate = cardRecord.header?.template;
  const template = typeof rawTemplate === 'string' && rawTemplate.trim()
    ? rawTemplate.trim()
    : 'blue';

  return {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
    },
    header: {
      title: {
        tag: 'plain_text',
        content: title,
      },
      template,
    },
    body: {
      elements: [
        {
          tag: 'markdown',
          content: '⚠️ 卡片内容过长或结构超限，已自动精简显示。\n请在 OpenCode Web 查看完整输出。',
        },
      ],
    },
  };
}

// 飞书事件数据类型（SDK 未导出，手动定义）
interface FeishuEventData {
  event_id?: string;
  token?: string;
  create_time?: string;
  event_type?: string;
  tenant_key?: string;
  ts?: string;
  uuid?: string;
  type?: string;
  app_id?: string;
  sender: {
    sender_id?: {
      union_id?: string;
      user_id?: string;
      open_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    root_id?: string;
    parent_id?: string;
    create_time: string;
    update_time?: string;
    chat_id: string;
    thread_id?: string;
    chat_type: string;
    message_type: string;
    content: string;
    mentions?: Array<{
      key: string;
      id: {
        union_id?: string;
        user_id?: string;
        open_id?: string;
      };
      name: string;
      tenant_key?: string;
    }>;
    user_agent?: string;
  };
}

// 消息事件类型
export interface FeishuMessageEvent {
  messageId: string;
  chatId: string;
  threadId?: string;
  parentId?: string;
  chatType: 'p2p' | 'group';
  senderId: string;
  senderType: 'user' | 'bot';
  content: string;
  msgType: string;
  attachments?: FeishuAttachment[];
  mentions?: Array<{ key: string; id: { open_id: string }; name: string }>;
  rawEvent: FeishuEventData;
}

export interface FeishuAttachment {
  type: 'image' | 'file';
  fileKey: string;
  fileName?: string;
  fileType?: string;
  fileSize?: number;
}

function getString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

function collectAttachmentsFromContent(content: unknown): FeishuAttachment[] {
  if (!content || typeof content !== 'object') return [];
  const attachments: FeishuAttachment[] = [];
  const visited = new Set<object>();
  const stack: unknown[] = [content];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current as object)) continue;
    visited.add(current as object);

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }

    const record = current as Record<string, unknown>;

    const imageKey = getString(record.image_key) || getString(record.imageKey);
    if (imageKey) {
      attachments.push({ type: 'image', fileKey: imageKey });
    }

    const fileKey = getString(record.file_key) || getString(record.fileKey);
    if (fileKey) {
      attachments.push({
        type: 'file',
        fileKey,
        fileName: getString(record.file_name) || getString(record.fileName),
        fileType: getString(record.file_type) || getString(record.fileType),
        fileSize: getNumber(record.file_size) || getNumber(record.fileSize),
      });
    }

    for (const value of Object.values(record)) {
      stack.push(value);
    }
  }

  return attachments;
}

function extractTextFromInteractive(content: unknown): string {
  if (!content || typeof content !== 'object') return '';
  const parts: string[] = [];
  const stack: unknown[] = [content];
  const visited = new Set<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current as object)) continue;
    visited.add(current as object);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    const node = current as Record<string, unknown>;
    if (typeof node.text === 'string' && node.text.trim()) {
      parts.push(node.text.trim());
    }
    if (typeof node.content === 'string' && node.content.trim()) {
      parts.push(node.content.trim());
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') stack.push(value);
    }
  }
  return parts.join(' ');
}

function extractTextFromPost(content: unknown): string {
  if (!content || typeof content !== 'object') return '';

  const outer = content as Record<string, unknown>;
  const langContent = outer.zh_cn ?? outer.en_us ?? outer.ja_jp;
  const resolved = langContent ?? content;

  const record = resolved as { content?: unknown; title?: unknown };
  const parts: string[] = [];
  const root = record.content;
  if (!root) return '';
  const stack: unknown[] = [root];
  const visited = new Set<object>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    if (visited.has(current as object)) continue;
    visited.add(current as object);

    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }

    const node = current as Record<string, unknown>;
    const tag = getString(node.tag);
    if ((tag === 'text' || tag === 'a') && typeof node.text === 'string') {
      parts.push(node.text);
    }

    for (const value of Object.values(node)) {
      stack.push(value);
    }
  }

  return parts.join(' ');
}

// 卡片动作事件类型
export interface FeishuCardActionEvent {
  openId: string;
  action: {
    tag: string;
    value: Record<string, unknown>;
  };
  token: string;
  messageId?: string;
  chatId?: string;
  threadId?: string;
  rawEvent: unknown;
}

export type FeishuCardActionResponse = object;

class FeishuClient extends EventEmitter {
  private client: lark.Client;
  private wsClient: lark.WSClient | null = null;
  private eventDispatcher: lark.EventDispatcher;
  private cardActionHandler?: (event: FeishuCardActionEvent) => Promise<FeishuCardActionResponse | void>;
  private cardUpdateQueue: Map<string, Promise<boolean>> = new Map();
  private lastMessageAt = 0;
  private wsIdleCheckTimer: ReturnType<typeof setInterval> | null = null;
  private wsStopped = false;
  private wsReconnectAttempt = 0;
  private processedMessageIds: Map<string, number> = loadProcessedIds();
  private readonly startedAt: number = Date.now();

  constructor() {
    super();
    this.client = new lark.Client({
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
      disableTokenCache: false,
    });

    // 创建事件分发器
    // loggerLevel 设为 error:SDK 默认 info 级别会对每个未订阅 handler 的事件
    // (task.task.update_tenant_v1、im.message.reaction 等飞书主动推送)打 warn,
    // 纯噪音且无害,但会撑爆 stderr 日志(曾涨到 1.1GB)。降到 error 从源头消除。
    this.eventDispatcher = new lark.EventDispatcher({
      encryptKey: feishuConfig.encryptKey,
      verificationToken: feishuConfig.verificationToken,
      loggerLevel: lark.LoggerLevel.error,
    });
  }

  private touchLastMessage(): void {
    this.lastMessageAt = Date.now();
  }

  private async doConnectWs(): Promise<void> {
    this.wsClient = new lark.WSClient({
      appId: feishuConfig.appId,
      appSecret: feishuConfig.appSecret,
    });
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    this.touchLastMessage();
    this.wsReconnectAttempt = 0;
  }

  private startIdleCheck(): void {
    this.stopIdleCheck();
  }

  private stopIdleCheck(): void {
    if (this.wsIdleCheckTimer) {
      clearInterval(this.wsIdleCheckTimer);
      this.wsIdleCheckTimer = null;
    }
  }

  private async reconnectWs(_reason: string): Promise<void> {
    return;
  }

  getConnectionStatus(): { connected: boolean; lastMessageAt: number } {
    return {
      connected: this.wsClient !== null && !this.wsStopped,
      lastMessageAt: this.lastMessageAt,
    };
  }

  // 启动长连接
  async start(): Promise<void> {
    console.log('[飞书] 正在启动长连接...');
    this.wsStopped = false;

    // 注册消息接收事件
    this.eventDispatcher.register({
      'im.message.receive_v1': (data) => {
        this.touchLastMessage();
        void this.handleMessage(data as FeishuEventData).catch(err => {
          console.error('[飞书] handleMessage 异步处理失败:', err);
        });
        return { msg: 'ok' };
      },
      'im.message.message_read_v1': (data) => {
        this.touchLastMessage();
        return { msg: 'ok' };
      },
    });

    // 注册卡片回调事件
    this.eventDispatcher.register({
      'card.action.trigger': async (data: unknown) => {
        this.touchLastMessage();
        return await this.handleCardAction(data);
      },
    } as unknown as Record<string, (data: unknown) => Promise<FeishuCardActionResponse | { msg: string }>>);

    await this.doConnectWs();
    this.startIdleCheck();
    console.log('[飞书] 长连接已建立');
  }

  // 监听群成员退群事件
  onMemberLeft(callback: (chatId: string, memberId: string) => void): void {
    type MemberLeftData = {
      chat_id?: string;
      users?: Array<{ user_id?: { open_id?: string } }>;
    };
    (this.eventDispatcher.register as (handlers: Record<string, (data: unknown) => { msg: string }>) => void)({
      'im.chat.member.user.deleted_v1': (data: unknown) => {
        const event = data as MemberLeftData;
        const chatId = event.chat_id;
        const users = event.users || [];
        for (const user of users) {
          const openId = user.user_id?.open_id;
          if (chatId && openId) callback(chatId, openId);
        }
        return { msg: 'ok' };
      },
    });
  }

  // 监听群解散事件
  onChatDisbanded(callback: (chatId: string) => void): void {
    type ChatDisbandedData = { chat_id?: string };
    (this.eventDispatcher.register as (handlers: Record<string, (data: unknown) => { msg: string }>) => void)({
      'im.chat.disbanded_v1': (data: unknown) => {
        const event = data as ChatDisbandedData;
        if (event.chat_id) callback(event.chat_id);
        return { msg: 'ok' };
      },
    });
  }

  // 监听消息撤回事件
  onMessageRecalled(callback: (event: { chat_id?: string; message_id?: string; [key: string]: unknown }) => void): void {
    (this.eventDispatcher.register as (handlers: Record<string, (data: unknown) => { msg: string }>) => void)({
      'im.message.recalled_v1': (data: unknown) => {
        callback(data as Record<string, unknown>);
        return { msg: 'ok' };
      },
    });
  }

  // 处理接收到的消息
  private async handleMessage(data: FeishuEventData): Promise<void> {
    try {
      const message = data.message;
      const sender = data.sender;

      const msgId = message.message_id;
      if (msgId) {
        if (this.processedMessageIds.has(msgId)) {
          console.log(`[飞书] 消息去重跳过: msgId=${msgId}`);
          return;
        }
        const now = Date.now();
        this.processedMessageIds.set(msgId, now);
        for (const [id, ts] of this.processedMessageIds) {
          if (now - ts > PROCESSED_ID_TTL_MS) {
            this.processedMessageIds.delete(id);
          }
        }
        saveProcessedIds(this.processedMessageIds);
      }

      const msgCreateTimeMs = message.create_time ? Number(message.create_time) : 0;
      const msgAgeMs = msgCreateTimeMs > 0 ? this.startedAt - msgCreateTimeMs : 0;
      if (msgCreateTimeMs > 0 && msgAgeMs > 30000) {
        console.log(`[飞书] 跳过历史消息(启动前 ${Math.round(msgAgeMs / 1000)}s): msgId=${msgId}`);
        return;
      }

      // bot 消息默认丢弃以防机器人互刷；仅放行白名单内的 bot（如协作的 agent bot）。
      // 放行后仍受群聊 requireMentionInGroup（需 @ 才触发）约束。
      if (sender.sender_type === 'bot') {
        const botOpenId = sender.sender_id?.open_id || '';
        const allowed = botOpenId && groupConfig.allowedBotOpenIds.has(botOpenId);
        console.log(`[飞书][bot-diag] 收到 bot 消息: openId=${botOpenId || '(空)'}, allowed=${allowed}, allowlist=[${Array.from(groupConfig.allowedBotOpenIds).join(',')}], msgId=${msgId}`);
        if (!allowed) {
          return;
        }
        console.log(`[飞书] 放行白名单 bot 消息: openId=${botOpenId}`);
      }

      const msgType = message.message_type;
      const rawContent = message?.content;

      // [DEBUG] 打印原始消息格式，用于排查图片传输问题
      console.log(`[飞书-DEBUG] 收到消息: msgType=${msgType}, chatId=${message.chat_id}, content=${typeof rawContent === 'string' ? rawContent.slice(0, 200) : 'null'}`);

      let content = '';
      let parsedContent: Record<string, unknown> | null = null;
      if (typeof rawContent !== 'string' || !rawContent.trim()) {
        content = typeof rawContent === 'string' ? rawContent : '';
      } else {
        try {
          parsedContent = JSON.parse(rawContent) as Record<string, unknown>;
          if (parsedContent && typeof parsedContent.text === 'string') {
            content = parsedContent.text;
          }
        } catch {
          content = rawContent;
        }
      }

      if (!content && parsedContent && msgType === 'post') {
        const postText = extractTextFromPost(parsedContent);
        if (postText) content = postText;
      }

      // interactive（卡片）消息：递归提取所有 text 字段，供关键词触发检测
      if (!content && parsedContent && msgType === 'interactive') {
        const cardText = extractTextFromInteractive(parsedContent);
        if (cardText) content = cardText;
      }

      // merge_forward（合并转发）：事件 content 里只有摘要，需调 im.message.get
      // 拉取子消息列表（含 upper_message_id），按各自类型提取文本后拼接成可读块。
      if (msgType === 'merge_forward') {
        // 配对插旗：必须在拉子消息的 await 之前【同步】调用，否则后到但更快的
        // @提问文字消息会先跑完而看不到旗标，无法合并 → 详见 forward-pairing.ts。
        forwardPairing.begin(message.chat_id, sender.sender_id?.open_id || '');
        const forwardText = await this.extractMergeForwardText(message.message_id);
        if (forwardText) {
          content = content ? `${content}\n${forwardText}` : forwardText;
        }
        forwardPairing.ready(message.chat_id, forwardText || '');
      }

      const attachments: FeishuAttachment[] = [];
      const attachmentMap = new Map<string, FeishuAttachment>();
      const addAttachment = (item: FeishuAttachment): void => {
        const key = `${item.type}:${item.fileKey}`;
        const existing = attachmentMap.get(key);
        if (!existing) {
          attachmentMap.set(key, item);
          return;
        }
        attachmentMap.set(key, {
          type: existing.type,
          fileKey: existing.fileKey,
          fileName: existing.fileName || item.fileName,
          fileType: existing.fileType || item.fileType,
          fileSize: existing.fileSize ?? item.fileSize,
        });
      };

      if (parsedContent && msgType === 'image') {
        const imageKey = getString(parsedContent.image_key) || getString(parsedContent.imageKey);
        if (imageKey) {
          addAttachment({ type: 'image', fileKey: imageKey });
        }
      }

      if (parsedContent && msgType === 'file') {
        const fileKey = getString(parsedContent.file_key) || getString(parsedContent.fileKey);
        if (fileKey) {
          addAttachment({
            type: 'file',
            fileKey,
            fileName: getString(parsedContent.file_name) || getString(parsedContent.fileName),
            fileType: getString(parsedContent.file_type) || getString(parsedContent.fileType),
            fileSize: getNumber(parsedContent.file_size) || getNumber(parsedContent.fileSize),
          });
        }
      }

      if (parsedContent) {
        const collected = collectAttachmentsFromContent(parsedContent);
        for (const item of collected) {
          addAttachment(item);
        }
      }

      attachments.push(...attachmentMap.values());

      // [DEBUG] 打印解析出的附件信息
      if (attachments.length > 0) {
        console.log(`[飞书-DEBUG] 解析到附件: ${JSON.stringify(attachments)}`);
      } else {
        console.log(`[飞书-DEBUG] 无附件, msgType=${msgType}`);
      }

      // 移除@机器人的部分
      if (message.mentions) {
        for (const mention of message.mentions) {
          content = content.replace(mention.key, '').trim();
        }
      }

      const messageEvent: FeishuMessageEvent = {
        messageId: message.message_id,
        chatId: message.chat_id,
        threadId: message.thread_id,
        parentId: message.parent_id,
        chatType: message.chat_type as 'p2p' | 'group',
        senderId: sender.sender_id?.open_id || '',
        senderType: sender.sender_type as 'user' | 'bot',
        content: content.trim(),
        msgType,
        attachments: attachments.length > 0 ? attachments : undefined,
        mentions: message.mentions?.map(m => ({
          key: m.key,
          id: { open_id: m.id.open_id || '' },
          name: m.name,
        })),
        rawEvent: data,
      };

      this.emit('message', messageEvent);
    } catch (error) {
      console.error('[飞书] 解析消息失败:', error);
    }
  }

  /**
   * 提取合并转发消息的文本内容。
   * 飞书合并转发(merge_forward)的事件 content 仅含摘要，需调用 im.message.get
   * 拉取子消息列表，按各子消息的 msg_type 分别提取文本，拼接成可读块。
   */
  private async extractMergeForwardText(messageId: string): Promise<string> {
    try {
      const response = await this.client.im.message.get({
        path: { message_id: messageId },
        params: { user_id_type: 'open_id' },
      });
      const items = response.data?.items ?? [];
      console.log(`[飞书][merge_forward] msgId=${messageId} 拉到子消息 ${items.length} 条`);

      const lines: string[] = [];
      for (const item of items) {
        // 跳过转发容器自身，只取被转发的子消息。
        if (item.message_id === messageId) continue;
        const childType = item.msg_type;
        const rawBody = item.body?.content;
        if (!rawBody) continue;

        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          parsed = null;
        }

        let text = '';
        if (parsed && typeof parsed.text === 'string') {
          text = parsed.text;
        } else if (parsed && childType === 'post') {
          text = extractTextFromPost(parsed);
        } else if (parsed && childType === 'interactive') {
          text = extractTextFromInteractive(parsed);
        } else if (childType === 'image') {
          text = '[图片]';
        } else if (childType === 'file') {
          const name = parsed ? getString(parsed.file_name) : undefined;
          text = name ? `[文件: ${name}]` : '[文件]';
        }

        text = text.trim();
        if (text) {
          const senderName = item.sender?.id ? `${item.sender.id.slice(-6)}` : '?';
          lines.push(`[${senderName}] ${text}`);
        }
      }

      if (lines.length === 0) {
        console.log(`[飞书][merge_forward] msgId=${messageId} 未提取到可读文本`);
        return '';
      }
      return `【转发消息】\n${lines.join('\n')}`;
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书][merge_forward] 拉取子消息失败:', formatted.message, formatted.responseData ?? '');
      return '';
    }
  }

  // 设置卡片动作处理器（支持直接返回新卡片）
  setCardActionHandler(handler: (event: FeishuCardActionEvent) => Promise<FeishuCardActionResponse | void>): void {
    this.cardActionHandler = handler;
  }

  // 处理卡片按钮点击（通过 CardActionHandler 处理，需要单独设置）
  private async handleCardAction(data: unknown): Promise<FeishuCardActionResponse | { msg: string }> {
    try {
      const event = data as {
        operator: { open_id: string };
        action: { tag: string; value: Record<string, unknown> };
        token: string;
        open_message_id?: string;
        message_id?: string;
        open_chat_id?: string;
        chat_id?: string;
        open_thread_id?: string;
        thread_id?: string;
        context?: {
          open_message_id?: string;
          message_id?: string;
          open_chat_id?: string;
          chat_id?: string;
          open_thread_id?: string;
          thread_id?: string;
        };
      };

      const messageId =
        event.open_message_id ||
        event.message_id ||
        event.context?.open_message_id ||
        event.context?.message_id;
      const chatId =
        event.open_chat_id ||
        event.chat_id ||
        event.context?.open_chat_id ||
        event.context?.chat_id;
      const threadId =
        event.open_thread_id ||
        event.thread_id ||
        event.context?.open_thread_id ||
        event.context?.thread_id;

      const cardEvent: FeishuCardActionEvent = {
        openId: event.operator.open_id,
        action: event.action,
        token: event.token,
        messageId,
        chatId,
        threadId,
        rawEvent: data,
      };

      if (this.cardActionHandler) {
        const response = await this.cardActionHandler(cardEvent);
        if (response !== undefined) {
          return response;
        }
        return { msg: 'ok' };
      }

      this.emit('cardAction', cardEvent);
      return { msg: 'ok' };
    } catch (error) {
      console.error('[飞书] 解析卡片事件失败:', error);
      return { msg: 'ok' };
    }
  }

  // 下载消息中的资源文件
  async downloadMessageResource(
    messageId: string,
    fileKey: string,
    type: 'image' | 'file' | 'audio' | 'video'
  ): Promise<{ writeFile: (filePath: string) => Promise<unknown>; headers: Record<string, unknown> } | null> {
    try {
      const response = await this.client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      });
      return {
        writeFile: response.writeFile,
        headers: response.headers as Record<string, unknown>,
      };
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书] 下载消息资源失败:', formatted.message, formatted.responseData ?? '');
      return null;
    }
  }

  // 发送文本消息
  async sendText(chatId: string, text: string): Promise<string | null> {
    try {
      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      const msgId = response.data?.message_id || null;
      if (msgId) {
        console.log(`[飞书] 发送文字成功: msgId=${msgId.slice(0, 16)}...`);
      } else {
        console.log('[飞书] 发送文字返回空消息ID');
      }
      return msgId;
    } catch (error) {
      const formatted = formatError(error);      const errCode = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: number }).code : undefined;
      const apiCode = extractApiCode(formatted.responseData);
      if (apiCode === 230002) {
        console.warn(`[飞书] 群不可用，发送文字失败: chatId=${chatId}`);
        this.emit('chatUnavailable', chatId);
        return null;
      }
      console.error(`[飞书] 发送文字失败: code=${errCode}, ${formatted.message}`);
      return null;
    }
  }

  async sendMentionText(chatId: string, mentions: Array<{ openId: string; name: string }>, text: string): Promise<string | null> {
    const atTags = mentions.map(m => `<at user_id="${m.openId}">${m.name}</at>`).join(' ');
    const fullText = atTags ? `${atTags} ${text}` : text;
    return this.sendText(chatId, fullText);
  }

  async sendTextToOpenId(openId: string, text: string): Promise<string | null> {
    try {
      const response = await this.client.im.message.create({
        params: { receive_id_type: 'open_id' },
        data: {
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      const msgId = response.data?.message_id || null;
      if (msgId) console.log(`[飞书] 发送私信成功: msgId=${msgId.slice(0, 16)}...`);
      return msgId;
    } catch (error) {
      const formatted = formatError(error);
      console.error(`[飞书] 发送私信失败: ${formatted.message}`);
      return null;
    }
  }

  // 回复消息
  async reply(messageId: string, text: string): Promise<string | null> {
    try {
      const response = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });

      const msgId = response.data?.message_id || null;
      if (msgId) {
        console.log(`[飞书] 回复成功: msgId=${msgId.slice(0, 16)}...`);
      } else {
        console.log('[飞书] 回复返回空消息ID');
      }
      return msgId;
    } catch (error) {
      const formatted = formatError(error);
      const errCode = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: number }).code : undefined;
      console.error(`[飞书] 回复失败: code=${errCode}, ${formatted.message}`);
      return null;
    }
  }

  // 回复卡片
  async replyCard(messageId: string, card: object): Promise<string | null> {
    try {
      const response = await this.client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      const msgId = response.data?.message_id || null;
      if (msgId) {
        console.log(`[飞书] 回复卡片成功: msgId=${msgId.slice(0, 16)}...`);
      } else {
        console.log('[飞书] 回复卡片返回空消息ID');
      }
      return msgId;
    } catch (error) {
      const formatted = formatError(error);
      const errCode = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: number }).code : undefined;
      console.error(`[飞书] 回复卡片失败: code=${errCode}, ${formatted.message}`);
      return null;
    }
  }

  // 更新卡片
  async updateCard(messageId: string, card: object): Promise<boolean> {
    const prev = this.cardUpdateQueue.get(messageId) || Promise.resolve(true);
    const next = prev
      .catch(() => true)
      .then(async () => {
        return await this.doUpdateCard(messageId, card);
      })
      .finally(() => {
        if (this.cardUpdateQueue.get(messageId) === next) {
          this.cardUpdateQueue.delete(messageId);
        }
      });

    this.cardUpdateQueue.set(messageId, next);
    return await next;
  }

  private async doUpdateCard(messageId: string, card: object, retryOnRateLimit = true): Promise<boolean> {
    try {
      const data = {
        msg_type: 'interactive',
        content: JSON.stringify(card),
      } as unknown as { content: string };
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data,
      });
      console.log(`[飞书] 更新卡片成功: msgId=${messageId.slice(0, 16)}...`);
      return true;
    } catch (error) {
      const formatted = formatError(error);
      const apiCode = extractApiCode(formatted.responseData);

      if (apiCode === 230020 && retryOnRateLimit) {
        console.warn(`[飞书] 更新卡片触发限频(230020)，3s 后重试: msgId=${messageId.slice(0, 16)}...`);
        await new Promise(resolve => setTimeout(resolve, 3000));
        return this.doUpdateCard(messageId, card, false);
      }

      const errCode = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: number }).code : undefined;
      const errMsg = typeof error === 'object' && error !== null && 'msg' in error ? (error as { msg?: string }).msg : undefined;
      console.error(`[飞书] 更新卡片失败: code=${errCode}, msg=${errMsg}, msgId=${messageId}`);
      console.error(`[飞书] 更新卡片错误详情: ${formatted.message}`);
      if (formatted.responseData) {
        try {
          console.error(`[飞书] 响应数据: ${JSON.stringify(formatted.responseData).slice(0, 500)}`);
        } catch {
          // ignore
        }
      }

      if (isUniversalCardBuildFailure(formatted.responseData)) {
        console.warn(`[飞书] 更新卡片触发 230099/200800，尝试发送精简卡片: msgId=${messageId}`);
        try {
          const fallbackData = {
            msg_type: 'interactive',
            content: JSON.stringify(buildFallbackInteractiveCard(card)),
          } as unknown as { content: string };
          await this.client.im.message.patch({
            path: { message_id: messageId },
            data: fallbackData,
          });
          console.log(`[飞书] 精简卡片更新成功: msgId=${messageId.slice(0, 16)}...`);
          return true;
        } catch (fallbackError) {
          const fallbackFormatted = formatError(fallbackError);
          console.error(`[飞书] 精简卡片更新失败: ${fallbackFormatted.message}`);
        }
      }
      return false;
    }
  }

  // 更新消息（用于定时刷新输出）
  async updateMessage(messageId: string, text: string): Promise<boolean> {
    try {
      await this.client.im.message.patch({
        path: { message_id: messageId },
        data: {
          content: JSON.stringify({ text }),
        },
      });
      return true;
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书] 更新消息失败:', formatted.message, formatted.responseData ?? '');
      return false;
    }
  }

  // 发送消息卡片
  async sendCard(chatId: string, card: object): Promise<string | null> {
    try {
      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });

      const msgId = response.data?.message_id || null;
      if (msgId) {
        console.log(`[飞书] 发送卡片成功: msgId=${msgId.slice(0, 16)}...`);
      } else {
        console.log('[飞书] 发送卡片返回空消息ID');
      }
      return msgId;
    } catch (error) {
      const formatted = formatError(error);
      const errCode = typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: number }).code : undefined;
      const apiCode = extractApiCode(formatted.responseData);
      if (apiCode === 230002) {
        console.warn(`[飞书] 群不可用，发送卡片失败: chatId=${chatId}`);
        this.emit('chatUnavailable', chatId);
        return null;
      }

      if (isUniversalCardBuildFailure(formatted.responseData)) {
        console.warn(`[飞书] 发送卡片触发 230099/200800，尝试占位卡片+patch 方案: chatId=${chatId}`);
        try {
          // Step 1: 先发占位精简卡片（create 接口只支持简单卡片）
          const fallbackResponse = await this.client.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: chatId,
              msg_type: 'interactive',
              content: JSON.stringify(buildFallbackInteractiveCard(card)),
            },
          });

          const fallbackMsgId = fallbackResponse.data?.message_id || null;
          if (!fallbackMsgId) {
            console.warn('[飞书] 占位卡片发送返回空消息ID');
            return null;
          }
          console.log(`[飞书] 占位卡片发送成功: msgId=${fallbackMsgId.slice(0, 16)}...`);

          // Step 2: patch 真实卡片内容（patch 接口支持完整 schema 2.0 卡片）
          const patchSuccess = await this.doUpdateCard(fallbackMsgId, card);
          if (patchSuccess) {
            console.log(`[飞书] 真实卡片 patch 成功: msgId=${fallbackMsgId.slice(0, 16)}...`);
          } else {
            console.warn(`[飞书] 真实卡片 patch 失败，保留占位卡片: msgId=${fallbackMsgId.slice(0, 16)}...`);
          }
          return fallbackMsgId;
        } catch (fallbackError) {
          const fallbackFormatted = formatError(fallbackError);
          console.error(`[飞书] 占位卡片发送失败: ${fallbackFormatted.message}`);
        }
      }

      console.error(`[飞书] 发送卡片失败: code=${errCode}, ${formatted.message}`);
      return null;
    }
  }

  // 撤回消息
  async deleteMessage(messageId: string): Promise<boolean> {
    try {
      await this.client.im.message.delete({
        path: { message_id: messageId },
      });
      return true;
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书] 撤回消息失败:', formatted.message, formatted.responseData ?? '');
      return false;
    }
  }

  // 指定群管理员
  async addChatManager(chatId: string, managerId: string, idType: 'open_id' | 'app_id'): Promise<boolean> {
    try {
      const response = await this.client.im.chatManagers.addManagers({
        path: { chat_id: chatId },
        params: { member_id_type: idType },
        data: { manager_ids: [managerId] },
      });

      return response.code === 0;
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书] 设置群管理员失败:', formatted.message, formatted.responseData ?? '');
      return false;
    }
  }

  // 创建群聊
  async createChat(name: string, userIds: string[], description?: string): Promise<{ chatId: string | null; invalidUserIds: string[] }> {
    try {
      const response = await this.client.im.chat.create({
        params: {
          user_id_type: 'open_id',
          set_bot_manager: true, // 设置机器人为管理员
        },
        data: {
          name,
          description,
          user_id_list: userIds,
        },
      });

      const chatId = response.data?.chat_id || null;
      // 飞书 API 返回的 invalid_id_list 包含无法添加的用户 ID
      const invalidUserIds = (response.data as { invalid_id_list?: string[] })?.invalid_id_list || [];
      
      if (response.code === 0 && chatId) {
        console.log(`[飞书] 创建群聊成功: chatId=${chatId}, name=${name}, userIds=${userIds.join(',')}`);
        if (invalidUserIds.length > 0) {
          console.warn(`[飞书] 创建群聊时部分用户添加失败: invalidIds=${invalidUserIds.join(',')}`);
        }
      } else {
        console.error(`[飞书] 创建群聊失败: code=${response.code}, msg=${response.msg}, name=${name}, userIds=${userIds.join(',')}`);
        if (response.data) {
          console.error(`[飞书] 创建群聊错误详情: ${JSON.stringify(response.data)}`);
        }
      }
      return { chatId, invalidUserIds };
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书] 创建群聊失败:', formatted.message, formatted.responseData ?? '');
      return { chatId: null, invalidUserIds: [] };
    }
  }

  // 解散群聊
  async disbandChat(chatId: string): Promise<boolean> {
    try {
      await this.client.im.chat.delete({
        path: { chat_id: chatId },
      });
      console.log(`[飞书] 解散群聊成功: chatId=${chatId}`);
      return true;
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书] 解散群聊失败:', formatted.message, formatted.responseData ?? '');
      return false;
    }
  }

  // 获取群成员列表 (返回 open_id 列表)
  async getChatMembers(chatId: string): Promise<string[]> {
    try {
      // 获取所有成员，支持分页
      const memberIds: string[] = [];
      let pageToken: string | undefined;
      
      do {
        const response = await this.client.im.chatMembers.get({
          path: { chat_id: chatId },
          params: {
            member_id_type: 'open_id',
            page_size: 100,
            page_token: pageToken,
          },
        });
        
        if (response.data?.items) {
          for (const item of response.data.items) {
            if (item.member_id) {
              memberIds.push(item.member_id);
            }
          }
        }
        pageToken = response.data?.page_token;
      } while (pageToken);

      return memberIds;
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书] 获取群成员失败:', formatted.message, formatted.responseData ?? '');
      return [];
    }
  }

  // 获取机器人所在的群列表
  // 注意：tenant_access_token 只能获取 Bot 主动加入的群，被拉进去的群不在列表中。
  // 使用场景：仅用于获取"bot 主动加入的群"，不能用于验证 bot 是否在某个具体群里。
  // 如需验证 bot 是否在群里，请使用 isBotInChat()。
  async getUserChats(): Promise<string[]> {
    try {
      const chatIds: string[] = [];
      let pageToken: string | undefined;

      do {
        const response = await this.client.im.chat.list({
          params: {
            page_size: 100,
            page_token: pageToken,
          },
        });

        if (response.data?.items) {
          for (const item of response.data.items) {
            if (item.chat_id) {
              chatIds.push(item.chat_id);
            }
          }
        }
        pageToken = response.data?.page_token;
      } while (pageToken);

      return chatIds;
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书] 获取群列表失败:', formatted.message, formatted.responseData ?? '');
      return [];
    }
  }

  async listRecentImageFromUser(
    chatId: string,
    senderId: string,
    beforeMessageId: string,
    lookbackSeconds: number = 300
  ): Promise<Array<{ messageId: string; fileKey: string }> | null> {
    try {
      const now = Math.floor(Date.now() / 1000);
      const startTime = String(now - lookbackSeconds);
      const results: Array<{ messageId: string; fileKey: string }> = [];

      let pageToken: string | undefined;
      do {
        const response = await this.client.im.message.list({
          params: {
            container_id_type: 'chat',
            container_id: chatId,
            start_time: startTime,
            end_time: String(now),
            sort_type: 'ByCreateTimeDesc',
            page_size: 20,
            page_token: pageToken,
          },
        });

        const items = response.data?.items ?? [];
        for (const item of items) {
          if (item.message_id === beforeMessageId) continue;
          if (item.sender?.id !== senderId) continue;
          if (item.msg_type !== 'image') continue;

          let fileKey: string | undefined;
          try {
            const content = JSON.parse(item.body?.content ?? '{}');
            fileKey = content.image_key;
          } catch { /* ignore parse errors */ }

          if (fileKey) {
            results.push({ messageId: item.message_id!, fileKey });
          }
        }

        pageToken = response.data?.page_token;
      } while (pageToken && results.length === 0);

      return results.length > 0 ? results : null;
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书] 查询最近图片失败:', formatted.message, formatted.responseData ?? '');
      return null;
    }
  }

  // 验证 Bot 是否在指定群里（无论主动加入还是被拉进去）
  // 用 chat.get 直接查询群信息，成功则表示 bot 有权限访问该群
  async isBotInChat(chatId: string): Promise<boolean | null> {
    try {
      const response = await this.client.im.chat.get({
        path: { chat_id: chatId },
        params: { user_id_type: 'open_id' },
      });
      return response.code === 0 && !!response.data;
    } catch {
      return null;
    }
  }

  // 获取群信息
  async getChat(chatId: string): Promise<{ ownerId: string; name: string } | null> {
    try {
      const response = await this.client.im.chat.get({
        path: { chat_id: chatId },
        params: { user_id_type: 'open_id' },
      });
      
      if (response.code === 0 && response.data) {
        return {
          ownerId: response.data.owner_id || '',
          name: response.data.name || '',
        };
      }
      return null;
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书] 获取群信息失败:', formatted.message, formatted.responseData ?? '');
      return null;
    }
  }

  // 邀请用户进群
  async addChatMembers(chatId: string, userIds: string[]): Promise<boolean> {
    try {
      const response = await this.client.im.chatMembers.create({
        path: { chat_id: chatId },
        params: { member_id_type: 'open_id' },
        data: { id_list: userIds },
      });
      if (response.code === 0) {
        console.log(`[飞书] 邀请用户 ${userIds.join(', ')} 进群 ${chatId} 成功`);
      } else {
        console.error(`[飞书] 邀请用户进群 ${chatId} 失败: code=${response.code}, msg=${response.msg}, userIds=${userIds.join(', ')}`);
        if (response.data) {
          console.error(`[飞书] 邀请用户进群错误详情: ${JSON.stringify(response.data)}`);
        }
      }
      return response.code === 0;
    } catch (error) {
      const formatted = formatError(error);
      console.error('[飞书] 邀请进群失败:', formatted.message, formatted.responseData ?? '');
      return false;
    }
  }

  // 上传图片，返回 image_key
  async uploadImage(imageData: Buffer | ReadStream): Promise<string | null> {
    try {
      const response = await this.client.im.image.create({
        data: {
          image_type: 'message',
          image: imageData,
        },
      });

      const imageKey = response?.image_key || null;
      if (imageKey) {
        console.log(`[飞书] 上传图片成功: imageKey=${imageKey.slice(0, 16)}...`);
      } else {
        console.log('[飞书] 上传图片返回空 image_key');
      }
      return imageKey;
    } catch (error) {
      const formatted = formatError(error);
      console.error(`[飞书] 上传图片失败: ${formatted.message}`);
      return null;
    }
  }

  // 上传文件，返回 file_key
  async uploadFile(
    fileData: Buffer | ReadStream,
    fileName: string,
    fileType: 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'
  ): Promise<string | null> {
    try {
      const response = await this.client.im.file.create({
        data: {
          file_type: fileType,
          file_name: fileName,
          file: fileData,
        },
      });

      const fileKey = response?.file_key || null;
      if (fileKey) {
        console.log(`[飞书] 上传文件成功: fileKey=${fileKey.slice(0, 16)}..., name=${fileName}`);
      } else {
        console.log('[飞书] 上传文件返回空 file_key');
      }
      return fileKey;
    } catch (error) {
      const formatted = formatError(error);
      console.error(`[飞书] 上传文件失败: ${formatted.message}`);
      return null;
    }
  }

  // 发送图片消息
  async sendImageMessage(chatId: string, imageKey: string): Promise<string | null> {
    try {
      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'image',
          content: JSON.stringify({ image_key: imageKey }),
        },
      });

      const msgId = response.data?.message_id || null;
      if (msgId) {
        console.log(`[飞书] 发送图片消息成功: msgId=${msgId.slice(0, 16)}...`);
      } else {
        console.log('[飞书] 发送图片消息返回空消息ID');
      }
      return msgId;
    } catch (error) {
      const formatted = formatError(error);
      const apiCode = extractApiCode(formatted.responseData);
      if (apiCode === 230002) {
        console.warn(`[飞书] 群不可用，发送图片消息失败: chatId=${chatId}`);
        this.emit('chatUnavailable', chatId);
        return null;
      }
      console.error(`[飞书] 发送图片消息失败: ${formatted.message}`);
      return null;
    }
  }

  // 发送文件消息
  async sendFileMessage(chatId: string, fileKey: string): Promise<string | null> {
    try {
      const response = await this.client.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        },
      });

      const msgId = response.data?.message_id || null;
      if (msgId) {
        console.log(`[飞书] 发送文件消息成功: msgId=${msgId.slice(0, 16)}...`);
      } else {
        console.log('[飞书] 发送文件消息返回空消息ID');
      }
      return msgId;
    } catch (error) {
      const formatted = formatError(error);
      const apiCode = extractApiCode(formatted.responseData);
      if (apiCode === 230002) {
        console.warn(`[飞书] 群不可用，发送文件消息失败: chatId=${chatId}`);
        this.emit('chatUnavailable', chatId);
        return null;
      }
      console.error(`[飞书] 发送文件消息失败: ${formatted.message}`);
      return null;
    }
  }

  // 添加消息表情回复（reaction）
  async addReaction(messageId: string, emojiType: string): Promise<string | null> {
    try {
      const response = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });

      const reactionId = response.data?.reaction_id || null;
      if (reactionId) {
        console.log(`[飞书] 添加 reaction 成功: msgId=${messageId.slice(0, 16)}..., emoji=${emojiType}`);
      }
      return reactionId;
    } catch (error) {
      const formatted = formatError(error);
      console.warn(`[飞书] 添加 reaction 失败: ${formatted.message}`);
      return null;
    }
  }

  // 删除消息表情回复（reaction）
  async removeReaction(messageId: string, reactionId: string): Promise<boolean> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
      console.log(`[飞书] 删除 reaction 成功: msgId=${messageId.slice(0, 16)}..., reactionId=${reactionId.slice(0, 16)}...`);
      return true;
    } catch (error) {
      const formatted = formatError(error);
      console.warn(`[飞书] 删除 reaction 失败: ${formatted.message}`);
      return false;
    }
  }

  // 停止长连接
  stop(): void {
    this.wsStopped = true;
    this.stopIdleCheck();
    if (this.wsClient) {
      try {
        this.wsClient.close();
      } catch {
        // ignore
      }
      this.wsClient = null;
    }
    console.log('[飞书] 已断开连接');
  }
}

// 单例导出
export const feishuClient = new FeishuClient();
