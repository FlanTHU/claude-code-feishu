import { feishuClient, type FeishuMessageEvent, type FeishuCardActionEvent, type FeishuAttachment } from '../feishu/client.js';
import { activeBackend, activeBackendId } from '../backend/active.js';
import { chatSessionStore } from '../store/chat-session.js';
import { outputBuffer } from '../opencode/output-buffer.js';
import { questionHandler, type PendingQuestion } from '../opencode/question-handler.js';
import { parseQuestionAnswerText } from '../opencode/question-parser.js';
import { parseCommand } from '../commands/parser.js';
import type { EffortLevel } from '../commands/effort.js';
import { commandHandler } from './command.js';
import { modelConfig, attachmentConfig, outputConfig, modelSupportsImages } from '../config.js';
import { resolveGroupAccess, buildMemberPromptPrefix, buildOwnerPromptPrefix } from '../permissions/group-access.js';
import { permissionHandler } from '../permissions/handler.js';
import { DirectoryPolicy } from '../utils/directory-policy.js';
import { parseProviderModelString } from '../utils/provider-model.js';
import { buildSessionTimestamp } from '../utils/session-title.js';
import { openCodeEventHub } from '../router/opencode-event-hub.js';
import type { PendingCompactionMessage } from '../router/opencode-event-hub.js';

import { randomUUID } from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';

type PendingReaction = { messageId: string; reactionId: string };

// 附件相关配置
const ATTACHMENT_BASE_DIR = path.resolve(process.cwd(), 'tmp', 'feishu-uploads');
const ALLOWED_ATTACHMENT_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf',
  '.pjp', '.pjpeg', '.jfif', '.jpe',
  '.xlsx', '.xls', '.csv', '.docx',
  // 文本类:走 file-path 分支,以路径形式进 prompt,由 AI 用 Read 工具读取
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.log',
]);
const DOCUMENT_EXTENSIONS = new Set([
  '.xlsx', '.xls', '.csv', '.docx',
  '.md', '.markdown', '.txt', '.json', '.yaml', '.yml', '.log',
]);

// Helper functions for file type detection
function getHeaderValue(headers: Record<string, unknown>, name: string): string {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      if (typeof value === 'string') return value;
      if (Array.isArray(value) && typeof value[0] === 'string') return value[0];
    }
  }
  return '';
}

function extractExtension(name: string): string {
  return path.extname(name).toLowerCase();
}

function normalizeExtension(ext: string): string {
  if (!ext) return '';
  const withDot = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  if (withDot === '.jpeg' || withDot === '.pjpeg' || withDot === '.pjp' || withDot === '.jpe' || withDot === '.jfif') {
    return '.jpg';
  }
  return withDot;
}

function extensionFromContentType(contentType: string): string {
  const type = contentType.split(';')[0]?.trim().toLowerCase();
  if (type === 'image/png') return '.png';
  if (type === 'image/jpeg') return '.jpg';
  if (type === 'image/gif') return '.gif';
  if (type === 'image/webp') return '.webp';
  if (type === 'application/pdf') return '.pdf';
  if (type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '.xlsx';
  if (type === 'application/vnd.ms-excel') return '.xls';
  if (type === 'text/csv') return '.csv';
  if (type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx';
  return '';
}

function mimeFromExtension(ext: string): string {
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
    case '.pjpeg':
    case '.pjp':
    case '.jfif':
    case '.jpe':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.pdf':
      return 'application/pdf';
    case '.xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.xls':
      return 'application/vnd.ms-excel';
    case '.csv':
      return 'text/csv';
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default:
      return 'application/octet-stream';
  }
}

function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]+/g, '_').trim();
  return cleaned || 'attachment';
}

type OpencodeFilePartInput = { type: 'file'; mime: string; url: string; filename?: string };
type OpencodeFilePathPart = { type: 'file-path'; filePath: string; filename: string };

type OpencodePartInput = { type: 'text'; text: string } | OpencodeFilePartInput | OpencodeFilePathPart;

export type QuestionSkipActionResult = 'applied' | 'not_found' | 'stale_card' | 'invalid_state';

export class GroupHandler {
  private pendingReactions: Map<string, PendingReaction> = new Map();
  /** bufferKey -> 用户消息 ID，用于完成 reaction 兜底（私聊等场景 replyMessageId 可能未正确传递） */
  private userMessageIdByBufferKey: Map<string, string> = new Map();
  private silenceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private heartbeatTimers: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor() {
    openCodeEventHub.setReplayHandler((msg: PendingCompactionMessage) =>
      this.processPrompt(msg.sessionId, msg.text, msg.chatId, msg.messageId, msg.attachments, msg.config, msg.promptEffort)
    );
  }

  async addTypingReaction(chatId: string, messageId: string): Promise<void> {
    const bufferKey = `chat:${chatId}`;
    this.userMessageIdByBufferKey.set(bufferKey, messageId);
    const reactionId = await feishuClient.addReaction(messageId, 'Typing');
    if (reactionId) {
      this.pendingReactions.set(chatId, { messageId, reactionId });
      console.log(`[Group] addTypingReaction: chatId=${chatId}, bufferKey=${bufferKey}, pendingKeys=[${Array.from(this.pendingReactions.keys()).join(', ')}]`);
    }
  }

  async removeTypingReaction(chatId: string): Promise<void> {
    const pending = this.pendingReactions.get(chatId);
    if (!pending) return;
    this.pendingReactions.delete(chatId);
    void feishuClient.removeReaction(pending.messageId, pending.reactionId).catch(() => undefined);
  }

  /**
   * 移除 Typing 表情，并根据内容添加合适的完成 reaction（如 DONE、BULL、LGTM 等）
   * @param chatId 主 key（与 addTypingReaction 一致）
   * @param completionEmoji 完成表情
   * @param fallbackChatId 若主 key 未命中则尝试（如 conversationId 与 buffer.chatId 格式不同时）
   * @param fallbackMessageId 若找不到 pending，尝试用此消息 ID 添加完成 reaction
   * @param bufferKey 用于从 userMessageIdByBufferKey 兜底查找用户消息 ID（私聊等场景）
   */
  async removeTypingAndAddCompletionReaction(
    chatId: string,
    completionEmoji: string,
    fallbackChatId?: string,
    fallbackMessageId?: string | null,
    bufferKey?: string
  ): Promise<void> {
    let pending = this.pendingReactions.get(chatId);
    let keyToDelete: string | undefined = pending ? chatId : undefined;
    if (!pending && fallbackChatId && fallbackChatId !== chatId) {
      pending = this.pendingReactions.get(fallbackChatId);
      keyToDelete = pending ? fallbackChatId : undefined;
    }
    if (pending) {
      this.pendingReactions.delete(keyToDelete!);
      if (bufferKey) this.userMessageIdByBufferKey.delete(bufferKey);
      void feishuClient.removeReaction(pending.messageId, pending.reactionId).catch(() => undefined);
      void feishuClient.addReaction(pending.messageId, completionEmoji).catch(() => undefined);
      return;
    }
    // 未找到 pending：依次尝试 fallbackMessageId、userMessageIdByBufferKey
    const msgId =
      (fallbackMessageId && fallbackMessageId.trim()) ||
      (bufferKey ? this.userMessageIdByBufferKey.get(bufferKey) : undefined);
    if (bufferKey) this.userMessageIdByBufferKey.delete(bufferKey);
    if (msgId) {
      console.log(`[Group] 使用兜底 messageId 添加完成 reaction: emoji=${completionEmoji}, source=${fallbackMessageId ? 'buffer' : 'userMessageIdByBufferKey'}`);
      void feishuClient.addReaction(msgId, completionEmoji).catch(() => undefined);
    } else {
      console.warn(
        `[Group] removeTypingAndAddCompletionReaction: 无可用 messageId, chatId=${chatId}, bufferKey=${bufferKey ?? 'none'}, keys=[${Array.from(this.pendingReactions.keys()).join(', ')}]`
      );
    }
  }

  cancelSilenceTimer(chatId: string): void {
    const timer = this.silenceTimers.get(chatId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.silenceTimers.delete(chatId);
    }
    const hb = this.heartbeatTimers.get(chatId);
    if (hb !== undefined) {
      clearInterval(hb);
      this.heartbeatTimers.delete(chatId);
    }
  }

  private ensureStreamingBuffer(chatId: string, sessionId: string, replyMessageId: string | null): void {
    const key = `chat:${chatId}`;
    const current = outputBuffer.get(key);
    if (current) {
      outputBuffer.clear(key);
    }

    outputBuffer.getOrCreate(key, chatId, sessionId, replyMessageId, 'group:ensureStreamingBuffer');
    if (replyMessageId) {
      outputBuffer.setReplyMessageId(key, replyMessageId);
    }
    openCodeEventHub.registerActiveBuffer(key);

    const prevHb = this.heartbeatTimers.get(chatId);
    if (prevHb !== undefined) {
      clearInterval(prevHb);
      this.heartbeatTimers.delete(chatId);
    }
    const hbId = setInterval(() => {
      const b = outputBuffer.get(key);
      if (!b || b.status !== 'running') {
        clearInterval(hbId);
        this.heartbeatTimers.delete(chatId);
        return;
      }
      const { connected, lastHeartbeatAt } = activeBackend.getConnectionStatus();
      const secondsSinceHeartbeat = Math.floor((Date.now() - lastHeartbeatAt) / 1000);
      if (!connected || secondsSinceHeartbeat > 120) {
        const reason = !connected ? 'OpenCode 连接已断开' : `超过 ${secondsSinceHeartbeat}s 无响应`;
        console.warn(`[Group] 心跳检测到异常: ${reason}, bufferKey=${key}`);
        outputBuffer.append(key, `\n\n❌ ${reason}，任务可能已中止。请重新发送指令。`);
        outputBuffer.setStatus(key, 'failed');
        clearInterval(hbId);
        this.heartbeatTimers.delete(chatId);
        return;
      }
      outputBuffer.markDirty(key);
    }, 60 * 1000);
    this.heartbeatTimers.set(chatId, hbId);
  }

  private textImpliesImage(text: string): boolean {
    const patterns = [
      /图片/, /截图/, /照片/, /看图/, /看这/, /看看这/, /这个图/, /那张图/,
      /这张图/, /这张照/, /这张片/, /帮我看看/, /帮我分析/, /分析这/, /分析一下这/,
      /识别这/, /识别图片/, /这是什么/, /这里面/, /图片里/, /照片里/, /截图里/,
      /图里/, /screenshot/, /image/, /photo/, /picture/, /look at this/, /analyze this/,
    ];
    const lower = text.toLowerCase();
    return patterns.some(p => p.test(lower));
  }

  private formatDispatchError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();

    if (normalized.includes('fetch failed') || normalized.includes('networkerror')) {
      return '与 OpenCode 的连接失败，请检查服务是否在线或网络是否超时';
    }

    if (normalized.includes('timed out') || normalized.includes('timeout')) {
      return '请求 OpenCode 超时，请稍后重试';
    }

    return `请求失败: ${message}`;
  }

  // 处理群聊消息
  async handleMessage(event: FeishuMessageEvent): Promise<void> {
    const { chatId, content, messageId, senderId, attachments, senderType, mentions, chatType: eventChatType } = event;
    const trimmed = content.trim();

    const access = resolveGroupAccess(senderId);

    // 1. 优先处理命令
    const command = parseCommand(trimmed);

    // 1.0 权限确认回复（y/n/always）：必须在普通命令分发与 owner 拦截之前处理，
    // 否则会被当作未知命令透传，或被 owner 校验挡掉，导致挂起的权限无法确认。
    if (command.type === 'permission') {
      const handled = await this.handlePermissionReply(event, command);
      if (handled) return;
      // 无挂起权限时落回普通处理（视作普通文本）
    }

    if (command.type !== 'prompt' && command.type !== 'permission') {
      if (!access.isOwner) {
        const allowedForMember = new Set(['help', 'status', 'panel']);
        if (!allowedForMember.has(command.type)) {
          await feishuClient.reply(messageId, '⛔ 权限不足，该操作需要 owner 执行。');
          return;
        }
      }
      console.log(`[Group] 收到命令: ${command.type}`);
      await commandHandler.handle(command, {
        chatId,
        messageId,
        senderId,
        chatType: eventChatType
      });
      return;
    }

    // 2. 非命令消息，立即添加 "OnIt" reaction 作为已收到确认
    void this.addTypingReaction(chatId, messageId);

    // 3. 检查是否有待回答的问题
    const hasPending = await this.checkPendingQuestion(chatId, trimmed, messageId, attachments);
    if (hasPending) return;

    // 4. 获取或创建会话
    let sessionId = chatSessionStore.getSessionId(chatId);
    if (!sessionId) {
      // 如果没有绑定会话，自动创建一个（走 DirectoryPolicy）
      const title = `群聊-${buildSessionTimestamp()}`;
      const chatDefault = chatSessionStore.getSession(chatId)?.defaultDirectory;
      const dirResult = DirectoryPolicy.resolve({ chatDefaultDirectory: chatDefault });
      const effectiveDir = dirResult.ok && dirResult.source !== 'server_default' ? dirResult.directory : undefined;
      const session = await activeBackend.createSession(title, effectiveDir);
      if (session) {
        sessionId = session.id;
        chatSessionStore.setSession(chatId, sessionId, senderId, title, {
          chatType: eventChatType,
          resolvedDirectory: session.directory,
        }); // senderId 暂时作为 creator
      } else {
        await feishuClient.reply(messageId, '❌ 无法创建 OpenCode 会话');
        return;
      }
    } else {
      const existingSession = chatSessionStore.getSession(chatId);
      console.log(`[Group-Session] Existing session: chatId=${chatId.slice(-12)}, sessionId=${sessionId}, chatType=${existingSession?.chatType}, title=${existingSession?.title}`);
    }

    // 5. 处理 Prompt
    // 记录用户消息ID
    chatSessionStore.updateLastInteraction(chatId, messageId);
    
    // 获取当前会话配置
    const sessionConfig = chatSessionStore.getSession(chatId);
    const promptText = command.text ?? trimmed;
    await this.processPrompt(sessionId, promptText, chatId, messageId, attachments, sessionConfig, command.promptEffort, access.isOwner ? 'owner' : 'member', senderId, senderType, mentions);
  }

  /**
   * 处理权限确认回复（y/n/always）。
   * 返回 true 表示已作为权限响应处理（无论成败），false 表示当前无挂起权限，
   * 调用方应把消息当普通文本继续处理。
   */
  private async handlePermissionReply(
    event: FeishuMessageEvent,
    command: ReturnType<typeof parseCommand>
  ): Promise<boolean> {
    const { chatId, messageId } = event;

    const pending = permissionHandler.peekForChat(chatId);
    if (!pending) {
      return false;
    }

    const allow = command.permissionAllow ?? (command.permissionResponse === 'y');
    const remember = command.permissionRemember ?? false;

    const responded = await activeBackend.respondToPermission(
      pending.sessionId,
      pending.permissionId,
      allow,
      remember
    );

    if (!responded) {
      console.error(
        `[Group-权限] 响应失败: chat=${chatId}, session=${pending.sessionId}, permission=${pending.permissionId}`
      );
      await feishuClient.reply(messageId, '权限响应失败，请重试');
      return true;
    }

    permissionHandler.resolveForChat(chatId, pending.permissionId);
    const toolName = pending.tool || '工具';
    console.log(
      `[Group-权限] 响应成功: chat=${chatId}, permission=${pending.permissionId}, allow=${allow}, remember=${remember}`
    );
    await feishuClient.reply(
      messageId,
      allow
        ? remember ? `✅ 已允许并记住权限：${toolName}` : `✅ 已允许权限：${toolName}`
        : `❌ 已拒绝权限：${toolName}`
    );
    return true;
  }

  // 检查待回答问题
  private async checkPendingQuestion(
    chatId: string,
    text: string,
    messageId: string, 
    attachments?: FeishuAttachment[],
    source: 'text' | 'button' = 'text'
  ): Promise<boolean> {
    const pending = questionHandler.getByConversationKey(`chat:${chatId}`);
    if (!pending) return false;

    // 如果有附件，提示先完成回答
    if (attachments && attachments.length > 0) {
      await feishuClient.reply(messageId, '当前有待回答问题，请先完成问题回答');
      return true;
    }

    const currentIndex = pending.currentQuestionIndex;
    const question = pending.request.questions[currentIndex];
    
    // 解析答案
    const parsed = parseQuestionAnswerText(text, question);
    if (!parsed) {
        await feishuClient.reply(messageId, '未识别答案，请回复选项编号/字母，或直接输入自定义内容。');
        return true;
    }

    // 更新草稿
    if (parsed.type === 'skip') {
        questionHandler.setDraftAnswer(pending.request.id, currentIndex, []);
        questionHandler.setDraftCustomAnswer(pending.request.id, currentIndex, '');
    } else if (parsed.type === 'custom') {
        questionHandler.setDraftAnswer(pending.request.id, currentIndex, []);
        questionHandler.setDraftCustomAnswer(pending.request.id, currentIndex, parsed.custom || text);
    } else {
        questionHandler.setDraftCustomAnswer(pending.request.id, currentIndex, '');
        questionHandler.setDraftAnswer(pending.request.id, currentIndex, parsed.values || []);
    }

    // 进入下一题或提交
    const nextIndex = currentIndex + 1;
    if (nextIndex < pending.request.questions.length) {
        questionHandler.setCurrentQuestionIndex(pending.request.id, nextIndex);
        outputBuffer.touch(`chat:${chatId}`);
    } else {
      // 提交所有答案
      await this.submitQuestionAnswers(pending, messageId, chatId);
    }

    return true;
  }

  // 处理题目卡片中的“跳过本题”按钮
  async handleQuestionSkipAction(params: {
    chatId: string;
    messageId?: string;
    requestId?: string;
    questionIndex?: number;
  }): Promise<QuestionSkipActionResult> {
    const pending = questionHandler.getByConversationKey(`chat:${params.chatId}`);
    if (!pending) {
      return 'not_found';
    }

    if (params.requestId && params.requestId !== pending.request.id) {
      return 'stale_card';
    }

    if (typeof params.questionIndex === 'number' && params.questionIndex !== pending.currentQuestionIndex) {
      return 'stale_card';
    }

    const messageId = params.messageId || pending.feishuCardMessageId;
    if (!messageId) {
      return 'invalid_state';
    }

    try {
      const handled = await this.checkPendingQuestion(params.chatId, '跳过', messageId, undefined, 'button');
      return handled ? 'applied' : 'not_found';
    } catch (error) {
      console.error('[Group] 处理跳过按钮失败:', error);
      return 'invalid_state';
    }
  }

  // 提交问题答案
  private async submitQuestionAnswers(
    pending: PendingQuestion,
    replyMessageId: string,
    chatId: string
  ): Promise<void> {
      const answers: string[][] = [];

      const totalQuestions = pending.request.questions.length;

      for (let i = 0; i < totalQuestions; i++) {
        const custom = (pending.draftCustomAnswers[i] || '').trim();
        if (custom) {
          answers.push([custom]);
        } else {
          answers.push(pending.draftAnswers[i] || []);
        }
      }

      console.log(`[Group] 提交问题回答: requestId=${pending.request.id.slice(0, 8)}...`);

      this.ensureStreamingBuffer(
        chatId,
        pending.request.sessionID,
        replyMessageId || null
      );

      const qaLines = pending.request.questions.map((q, i) => {
        const ans = answers[i] && answers[i].length > 0 ? answers[i].join(', ') : '（跳过）';
        return `- ${q.question}\n  → ${ans}`;
      }).join('\n');
      const compensationText = `[系统提示] 以下是你刚才通过 question 工具提问的内容及用户的回答，请在此基础上继续：\n${qaLines}`;

      const success = await activeBackend.replyQuestion(pending.request.id, answers);

      if (success) {
        questionHandler.remove(pending.request.id);
        outputBuffer.touch(`chat:${chatId}`);

        try {
          const sessionData = chatSessionStore.getSession(chatId);
          const sessionDir = sessionData?.resolvedDirectory || sessionData?.sessionDirectory;
          await activeBackend.sendMessagePartsAsync(
            pending.request.sessionID,
            [{ type: 'text', text: compensationText }],
            sessionDir ? { directory: sessionDir } : undefined
          );
          console.log(`[Group] 已注入问答补偿消息: session=${pending.request.sessionID.slice(0, 8)}...`);
        } catch (compensationError) {
          console.warn('[Group] 注入问答补偿消息失败，跳过:', compensationError);
        }
      } else {
          await feishuClient.reply(replyMessageId, '⚠️ 回答提交失败，请重试');
      }
  }


  // 清除上下文
  private async handleClear(chatId: string, messageId: string): Promise<void> {
    const sessionId = chatSessionStore.getSessionId(chatId);
    if (sessionId) {
      // OpenCode 目前可能没有 deleteSession 接口，或者仅仅是解绑？
      // 按照之前的逻辑，可能是 deleteSession
      await activeBackend.deleteSession(sessionId);
      chatSessionStore.removeSession(chatId);
      await feishuClient.reply(messageId, '🧹 会话上下文已清除，新消息将开启新会话。');
    } else {
      await feishuClient.reply(messageId, '当前没有活跃的会话。');
    }
  }

  // 处理消息发送
   private async processPrompt(
    sessionId: string,
    text: string,
    chatId: string,
    messageId: string,
    attachments?: FeishuAttachment[],
    config?: { preferredModel?: string; preferredAgent?: string; preferredEffort?: EffortLevel },
    promptEffort?: EffortLevel,
    senderRole: 'owner' | 'member' = 'owner',
    senderId?: string,
    senderType: 'user' | 'bot' = 'user',
    mentions?: Array<{ key: string; id: { open_id: string }; name: string }>
  ): Promise<void> {
    const bufferKey = `chat:${chatId}`;
    this.ensureStreamingBuffer(chatId, sessionId, messageId);

    const prevSilenceTimer = this.silenceTimers.get(chatId);
    if (prevSilenceTimer !== undefined) {
      clearTimeout(prevSilenceTimer);
      this.silenceTimers.delete(chatId);
    }

    try {
      await commandHandler.sanitizePreferredAgentForChat(chatId);
      const sessionPrefs = chatSessionStore.getSession(chatId);
      const effectiveConfig:
        | { preferredModel?: string; preferredAgent?: string; preferredEffort?: EffortLevel }
        | undefined = sessionPrefs
        ? {
            preferredModel: sessionPrefs.preferredModel,
            preferredAgent: sessionPrefs.preferredAgent,
            preferredEffort: sessionPrefs.preferredEffort,
          }
        : config;

      console.log(`[Group] 发送消息: chat=${chatId}, session=${sessionId.slice(0, 8)}...`);

      const parts: OpencodePartInput[] = [];

      const sessionData2 = chatSessionStore.getSession(chatId);
      const currentChatType = sessionData2?.chatType ?? 'group';
      const chatTypeLabel = currentChatType === 'p2p' ? '私聊' : '群聊';

      // [飞书] 前缀：配合 hmem R-prefix 规则实现亲切、有人味儿的回复风格
      let effectiveText = `[飞书] ${text}`;
      const senderTag = senderType === 'bot' ? `,sender=bot` : '';
      const mentionsTag = mentions && mentions.length > 0
        ? `,mentions=${mentions.map(m => `${m.id.open_id}:${m.name}`).join(';')}`
        : '';
      effectiveText += `\n<!--ctx:type=${currentChatType},send_file_to=${chatId},sender_id=${senderId || 'unknown'}${senderTag}${mentionsTag}-->`;

      // 注入来源标记，防止 prompt 注入攻击
      const sourcePrefix = senderId
        ? (senderRole === 'owner'
            ? buildOwnerPromptPrefix(senderId)
            : buildMemberPromptPrefix(senderId))
        : '';
      if (sourcePrefix) {
        effectiveText = sourcePrefix + effectiveText;
      }

      if (effectiveText) {
        parts.push({ type: 'text', text: effectiveText });
      }

      const hasIncomingAttachments = attachments && attachments.length > 0;

      if (!hasIncomingAttachments && senderId && currentChatType === 'group' && this.textImpliesImage(text)) {
        const recentImages = await feishuClient.listRecentImageFromUser(chatId, senderId, messageId, 300);
        if (recentImages && recentImages.length > 0) {
          const imageAttachments: FeishuAttachment[] = recentImages.map(img => ({
            type: 'image' as const,
            fileKey: img.fileKey,
          }));
          const imgPrepared = await this.prepareAttachmentParts(recentImages[0].messageId, imageAttachments);
          for (const part of imgPrepared.parts) {
            if (part.type !== 'file-path') {
              parts.push(part);
            }
          }
        }
      }

      if (hasIncomingAttachments) {
        console.log(`[DEBUG] 处理附件: count=${attachments.length}, types=${attachments.map(a => a.type).join(',')}`);
        const prepared = await this.prepareAttachmentParts(messageId, attachments);
        console.log(`[DEBUG] 附件处理完成: parts=${prepared.parts.length}, warnings=${prepared.warnings.length}`);
        if (prepared.warnings.length > 0) {
          await feishuClient.reply(messageId, `⚠️ 附件警告:\n${prepared.warnings.join('\n')}`);
        }
        const fileParts: string[] = [];
        for (const part of prepared.parts) {
          if (part.type === 'file-path') {
            fileParts.push(`[附件文件] 文件名: ${part.filename}\n文件路径: ${part.filePath}`);
          } else {
            parts.push(part);
          }
        }
        if (fileParts.length > 0) {
          const fileNote = fileParts.join('\n\n');
          const existingText = parts.find(p => p.type === 'text');
          if (existingText && existingText.type === 'text') {
            existingText.text = existingText.text + '\n\n' + fileNote;
          } else {
            parts.push({ type: 'text', text: fileNote });
          }
        }
      }

      if (parts.length === 0) {
        await feishuClient.reply(messageId, '未检测到有效内容');
        outputBuffer.setStatus(`chat:${chatId}`, 'completed');
        return;
      }

      // 提取 providerId 和 modelId（与 /model、面板 解析一致：第一个 : 或 / 为分隔符，模型 id 可含额外 :）
      let providerId: string | undefined;
      let modelId: string | undefined;

      if (modelConfig.defaultProvider && modelConfig.defaultModel) {
        providerId = modelConfig.defaultProvider;
        modelId = modelConfig.defaultModel;
      }

      if (effectiveConfig?.preferredModel) {
        const raw = effectiveConfig.preferredModel.trim();
        const parsed = parseProviderModelString(raw);
        if (parsed) {
          providerId = parsed.providerId;
          modelId = parsed.modelId;
        } else if (providerId) {
          // 兼容历史数据：仅模型名、无分隔符时，复用环境中的 provider
          modelId = raw;
        }
      }

      // Claude 后端:opus/sonnet 均支持图片,且 providerId/modelId 是 opencode 风格
      // (modelSupportsImages 查不到会误判为不支持),故跳过这个 opencode 专属检查。
      if (providerId && modelId && activeBackendId !== 'claude') {
        const hasImageAttachments = parts.some(p => p.type === 'file' && p.mime?.startsWith('image/'));
        if (hasImageAttachments && !modelSupportsImages(`${providerId}/${modelId}`)) {
          const imageCount = parts.filter(p => p.type === 'file' && p.mime?.startsWith('image/')).length;
          parts.splice(0, parts.length, ...parts.filter(p => !(p.type === 'file' && p.mime?.startsWith('image/'))));
          await feishuClient.reply(messageId, `⚠️ 当前模型不支持图片，已忽略 ${imageCount} 张图片。如需处理图片请先切换模型：/model claude-sonnet`);
        }
      }

      if (chatSessionStore.isCompacting(sessionId)) {
        console.log(`[Group] session 正在 compaction，消息入队: session=${sessionId.slice(0, 8)}...`);
        openCodeEventHub.enqueueCompactionMessage({
          sessionId,
          chatId,
          text,
          messageId,
          attachments,
          config: effectiveConfig,
          promptEffort,
        });
        return;
      }

      // 异步触发 OpenCode 请求，后续输出通过事件流持续推送
      const variant = promptEffort || effectiveConfig?.preferredEffort;
      // 从 store 获取会话的工作目录，传递给 OpenCode 以切换 Instance 上下文
      const sessionData = chatSessionStore.getSession(chatId);
      let directory = sessionData?.resolvedDirectory;
      // 如果 store 没有记录（老会话），尝试从 OpenCode 聚合查询并回写缓存
      if (!directory) {
        try {
          const storeKnownDirs = chatSessionStore.getKnownDirectories();
          const sessions = await activeBackend.listAllSessions(storeKnownDirs);
          const matched = sessions.find(s => s.id === sessionId);
          if (matched?.directory) {
            directory = matched.directory;
            // 回写缓存，后续消息不再重复查询
            chatSessionStore.updateResolvedDirectory(chatId, directory);
          } else {
            console.warn(`[Group] 未解析到 session 目录，依赖全局事件流: session=${sessionId.slice(0, 8)}...`);
          }
        } catch {
          // 获取失败不阻塞消息发送
        }
      }
      const filteredParts = parts.filter((p): p is { type: 'text'; text: string } | { type: 'file'; mime: string; url: string; filename?: string } =>
        p.type === 'text' || p.type === 'file'
      );
      console.log(`[DEBUG] 发送到 OpenCode: parts=${filteredParts.length}, types=${filteredParts.map(p => p.type).join(',')}`);
      void activeBackend.sendMessagePartsAsync(
        sessionId,
        filteredParts,
        {
          providerId,
          modelId,
          agent: effectiveConfig?.preferredAgent,
          ...(variant ? { variant } : {}),
          ...(directory ? { directory } : {}),
        }
      ).catch((err: unknown) => {
        const errorMessage = err instanceof Error ? err.message : String(err);
        console.error('[Group] sendMessagePartsAsync 失败:', errorMessage);
        outputBuffer.append(bufferKey, `\n\n❌ ${errorMessage}`);
        outputBuffer.setStatus(bufferKey, 'failed');
        groupHandler.cancelSilenceTimer(chatId);
      });

      if (outputConfig.silenceTimeoutMs > 0) {
        const timeoutMs = outputConfig.silenceTimeoutMs;
        const heartbeatIntervalMs = 60 * 1000;
        const capturedBufferKey = bufferKey;
        const capturedChatId = chatId;

        const timerId = setTimeout(() => {
          this.silenceTimers.delete(capturedChatId);
          const buf = outputBuffer.get(capturedBufferKey);
          if (!buf || buf.status !== 'running') {
            return;
          }
          const textContent = buf.content.join('').trim();
          const hasTextContent = buf.finalText.length > 0 || textContent.length > 0;
          if (hasTextContent) return;
          console.warn(`[Group] 静默超时 ${timeoutMs}ms，无文字输出: key=${capturedBufferKey}`);
          outputBuffer.append(capturedBufferKey, '⏳ 正在处理中，请稍候...');
        }, timeoutMs);
        this.silenceTimers.set(chatId, timerId);
      }

    } catch (error) {
      const errorMessage = this.formatDispatchError(error);
      console.error('[Group] 请求派发失败:', error);

      outputBuffer.append(bufferKey, `\n\n❌ ${errorMessage}`);
      outputBuffer.setStatus(bufferKey, 'failed');

      const currentBuffer = outputBuffer.get(bufferKey);
      if (!currentBuffer?.messageId) {
        await feishuClient.reply(messageId, `❌ ${errorMessage}`);
      }
    }
  }

  // 公开的 prompt 调度方法，供 command 层（如 /send 命令）调用
  async dispatchPrompt(sessionId: string, text: string, chatId: string, messageId: string): Promise<void> {
    const config = chatSessionStore.getSession(chatId);
    await this.processPrompt(sessionId, text, chatId, messageId, undefined, config);
  }

  // 处理附件
  private async prepareAttachmentParts(
    messageId: string,
    attachments: FeishuAttachment[]
  ): Promise<{ parts: (OpencodeFilePartInput | OpencodeFilePathPart)[]; warnings: string[] }> {
    const parts: (OpencodeFilePartInput | OpencodeFilePathPart)[] = [];
    const warnings: string[] = [];

    await fs.mkdir(ATTACHMENT_BASE_DIR, { recursive: true }).catch(() => undefined);

    for (const attachment of attachments) {
        if (attachment.fileSize && attachment.fileSize > attachmentConfig.maxSize) {
            warnings.push(`附件 ${attachment.fileName} 过大，已跳过`);
            continue;
        }

        const resource = await feishuClient.downloadMessageResource(messageId, attachment.fileKey, attachment.type);
        if (!resource) {
            warnings.push(`附件 ${attachment.fileName || '未知'} 下载失败`);
            continue;
        }

        const contentType = getHeaderValue(resource.headers || {}, 'content-type');
        const extFromName = attachment.fileName ? extractExtension(attachment.fileName) : '';
        const extFromType = attachment.fileType ? normalizeExtension(attachment.fileType) : '';
        const extFromContent = contentType ? extensionFromContentType(contentType) : '';
        let ext = normalizeExtension(extFromName || extFromType || extFromContent);
        
        if (!ext && attachment.type === 'image') {
            ext = '.jpg';
        }

        if (!ext || !ALLOWED_ATTACHMENT_EXTENSIONS.has(ext)) {
            console.log(`[附件] 不支持的格式: ext=${ext || 'unknown'}, contentType=${contentType}`);
            warnings.push(`附件格式不支持 (${ext || 'unknown'})，已跳过`);
            continue;
        }

        const fileId = randomUUID();
        const rawName = attachment.fileName || `attachment${ext}`;
        const safeName = sanitizeFilename(rawName.endsWith(ext) ? rawName : `${rawName}${ext}`);

        if (DOCUMENT_EXTENSIONS.has(ext)) {
            const filePath = path.join(ATTACHMENT_BASE_DIR, `${fileId}-${safeName}`);
            try {
                await resource.writeFile(filePath);
                parts.push({ type: 'file-path', filePath, filename: safeName });
            } catch (e) {
                warnings.push(`附件处理失败: ${attachment.fileName}`);
            }
        } else {
            const filePath = path.join(ATTACHMENT_BASE_DIR, `${fileId}${ext}`);
            try {
                await resource.writeFile(filePath);
                const buffer = await fs.readFile(filePath);
                const base64 = buffer.toString('base64');
                
                let mime = contentType ? contentType.split(';')[0].trim() : '';
                if (!mime || mime === 'application/octet-stream') {
                    mime = mimeFromExtension(ext);
                }
                
                const dataUrl = `data:${mime};base64,${base64}`;

                parts.push({
                    type: 'file',
                    mime,
                    url: dataUrl,
                    filename: safeName
                });
            } catch (e) {
                warnings.push(`附件处理失败: ${attachment.fileName}`);
            } finally {
                fs.unlink(filePath).catch(() => {});
            }
        }
    }

    return { parts, warnings };

  }
}

export const groupHandler = new GroupHandler();
