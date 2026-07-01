import * as fs from 'fs';
import * as path from 'path';
import type { EffortLevel } from '../commands/effort.js';
import { botDialogModeStore } from './bot-dialog-mode.js';

export type ChatSessionType = 'p2p' | 'group';

interface ChatSessionData {
  chatId: string;
  sessionId: string;
  sessionDirectory?: string;
  creatorId: string;
  createdAt: number;
  title?: string;
  chatType?: ChatSessionType;
  protectSessionDelete?: boolean;
  lastFeishuUserMsgId?: string;
  lastFeishuAiMsgId?: string;
  preferredModel?: string;
  preferredAgent?: string;
  preferredEffort?: EffortLevel;
  /** 最近选用的模型标识（provider:model），用于面板优先展示 */
  recentModelIds?: string[];
  resolvedDirectory?: string;
  projectName?: string;
  defaultDirectory?: string;
  reminderSent?: boolean;
  /** bot↔bot 连续接力的当前往返轮数。白名单 bot 触发时 +1，owner 真人发言清零。 */
  botRelayRounds?: number;
  /** 最近一次 bot 接力计数的时间戳（ms），用于冷却过期自动归零。 */
  lastBotRelayAt?: number;
  interactionHistory: InteractionRecord[];
}

interface SessionAliasRecord {
  chatId: string;
  expiresAt: number;
}

export interface InteractionRecord {
  userFeishuMsgId: string;
  openCodeMsgId: string;
  botFeishuMsgIds: string[];
  type: 'normal' | 'question_prompt' | 'question_answer';
  cardData?: any;
  timestamp: number;
}

export interface SessionBindingOptions {
  protectSessionDelete?: boolean;
  chatType?: ChatSessionType;
  sessionDirectory?: string;
  resolvedDirectory?: string;
  projectName?: string;
}

const STORE_FILE = path.join(process.cwd(), '.chat-sessions.json');
const SESSION_ALIAS_TTL_MS = 10 * 60 * 1000;
const NAMESPACE_SEPARATOR = ':';
type PlatformId = string;

// oh-my-openagent 的 display name → config key 映射（来自 AGENT_DISPLAY_NAMES）
const AGENT_DISPLAY_NAME_TO_KEY: Record<string, string> = {
  'sisyphus - ultraworker': 'sisyphus',
  'hephaestus - deep agent': 'hephaestus',
  'prometheus - plan builder': 'prometheus',
  'atlas - plan executor': 'atlas',
  'sisyphus-junior': 'sisyphus-junior',
  'metis - plan consultant': 'metis',
  'momus - plan critic': 'momus',
  'athena - council': 'athena',
  'athena-junior - council': 'athena-junior',
};

// config key → display name 反向映射（存量数据兼容）
const AGENT_KEY_TO_DISPLAY: Record<string, string> = Object.fromEntries(
  Object.entries(AGENT_DISPLAY_NAME_TO_KEY).map(([display, key]) => [key, display.charAt(0).toUpperCase() + display.slice(1)])
);

/**
 * 规范化 agent 名称：清理零宽字符，确保返回 display name（与 OpenCode 对齐）
 * 支持三种输入：display name、config key、带零宽字符的变体
 */
export function normalizeAgentName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[\u200b\u200c\u200d\ufeff]/g, '').trim();
  if (!cleaned) return undefined;
  // 如果输入是 config key，转成 display name
  const lower = cleaned.toLowerCase();
  if (AGENT_KEY_TO_DISPLAY[lower]) return AGENT_KEY_TO_DISPLAY[lower];
  // 否则返回清理后的值（可能是 display name 或其他有效名称）
  return cleaned;
}

class ChatSessionStore {
  private data: Map<string, ChatSessionData> = new Map();
  private sessionAliases: Map<string, SessionAliasRecord> = new Map();
  private compactingSessionIds: Set<string> = new Set();

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(STORE_FILE)) {
        const content = fs.readFileSync(STORE_FILE, 'utf-8');
        const parsed = JSON.parse(content);
        this.data = new Map(Object.entries(parsed));
        this.sanitizeLoadedData();
        this.save();
        console.log(`[Store] 已加载 ${this.data.size} 个群组会话`);
      }
    } catch (error) {
      console.error('[Store] 加载数据失败:', error);
    }
  }

  private sanitizeLoadedData(): void {
    for (const session of this.data.values()) {
      if (session && typeof session === 'object' && 'preferredAgent' in session) {
        const raw = (session as ChatSessionData).preferredAgent;
        if (typeof raw === 'string') {
          const normalized = normalizeAgentName(raw);
          if (!normalized) {
            console.warn(`[Store] 加载时清除无效 preferredAgent: ${JSON.stringify(raw)}`);
            delete (session as ChatSessionData).preferredAgent;
          } else if (normalized !== raw) {
            (session as ChatSessionData).preferredAgent = normalized;
          }
        }
      }
    }
  }

  private save(): void {
    try {
      const obj = Object.fromEntries(this.data);
      fs.writeFileSync(STORE_FILE, JSON.stringify(obj, null, 2));
    } catch (error) {
      console.error('[Store] 保存数据失败:', error);
    }
  }

  private inferChatTypeFromTitle(title?: string): ChatSessionType | undefined {
    if (!title) return undefined;
    if (title.startsWith('飞书私聊') || title.startsWith('私聊-')) return 'p2p';
    if (title.startsWith('飞书群聊') || title.startsWith('群聊-') || title.startsWith('群聊会话')) return 'group';
    return undefined;
  }

  private makeConversationKey(platform: string, chatId: string): string {
    return `${platform}:${chatId}`;
  }

  private parseConversationKey(key: string): { platform: string; chatId: string } | null {
    const idx = key.indexOf(NAMESPACE_SEPARATOR);
    if (idx <= 0) return null;
    return { platform: key.slice(0, idx), chatId: key.slice(idx + 1) };
  }

  private isNamespacedKey(key: string): boolean {
    return key.includes(NAMESPACE_SEPARATOR);
  }

  private legacyToNamespacedKey(chatId: string): string {
    return this.makeConversationKey('feishu', chatId);
  }

  private hasLegacyKey(chatId: string): boolean {
    return this.data.has(chatId);
  }

  private getChatDataLegacyOrNamespaced(chatId: string): ChatSessionData | undefined {
    const namespacedKey = this.legacyToNamespacedKey(chatId);
    if (this.data.has(namespacedKey)) {
      return this.data.get(namespacedKey);
    }
    return this.data.get(chatId);
  }

  /**
   * 获取会话 ID（平台感知版本）
   * @param platform 平台标识（如 'feishu', 'discord'）
   * @param conversationId 平台原生会话 ID
   * @returns sessionId 或 null
   */
  getSessionIdByConversation(platform: string, conversationId: string): string | null {
    const key = this.makeConversationKey(platform, conversationId);
    const data = this.data.get(key);
    return data?.sessionId || null;
  }

  /**
   * 获取会话数据（平台感知版本）
   * @param platform 平台标识
   * @param conversationId 平台原生会话 ID
   * @returns ChatSessionData 或 undefined
   */
  getSessionByConversation(platform: string, conversationId: string): ChatSessionData | undefined {
    const key = this.makeConversationKey(platform, conversationId);
    return this.data.get(key);
  }

  /**
   * 反向查找：通过 sessionId 获取 {platform, conversationId}
   * @param sessionId 会话 ID
   * @returns { platform, conversationId } 或 null
   */
  getConversationBySessionId(sessionId: string): { platform: string; conversationId: string } | null {
    for (const [key, data] of this.data.entries()) {
      if (data.sessionId === sessionId) {
        const parsed = this.parseConversationKey(key);
        if (parsed) {
          return { platform: parsed.platform, conversationId: parsed.chatId };
        }
      }
    }
    return null;
  }

  /**
   * 旧版 getSessionId（兼容 Feishu 调用方）
   * 读取时优先 namespaced key，回退到 legacy key
   */
  getSessionId(chatId: string): string | null {
    const namespacedKey = this.legacyToNamespacedKey(chatId);
    if (this.data.has(namespacedKey)) {
      const data = this.data.get(namespacedKey);
      return data?.sessionId || null;
    }
    const data = this.data.get(chatId);
    return data?.sessionId || null;
  }

  /**
   * 旧版 getSession（兼容 Feishu 调用方）
   * 读取时优先 namespaced key，回退到 legacy key
   */
  getSession(chatId: string): ChatSessionData | undefined {
    const namespacedKey = this.legacyToNamespacedKey(chatId);
    if (this.data.has(namespacedKey)) {
      return this.data.get(namespacedKey);
    }
    return this.data.get(chatId);
  }

  getKnownDirectories(): string[] {
    const dirs = new Set<string>();
    for (const data of this.data.values()) {
      if (data.resolvedDirectory) dirs.add(data.resolvedDirectory);
      if (data.defaultDirectory) dirs.add(data.defaultDirectory);
    }
    return [...dirs];
  }

  getChatId(sessionId: string): string | undefined {
    this.cleanupExpiredSessionAliases();

    for (const [storageKey, data] of this.data.entries()) {
      if (data.sessionId === sessionId) {
        const parsed = this.parseConversationKey(storageKey);
        if (parsed) {
          return parsed.chatId;
        }
        return storageKey;
      }
    }

    const alias = this.sessionAliases.get(sessionId);
    if (!alias) {
      return undefined;
    }

    if (alias.expiresAt <= Date.now()) {
      this.sessionAliases.delete(sessionId);
      return undefined;
    }

    const hasMatchingKey = Array.from(this.data.keys()).some(key => {
      const parsed = this.parseConversationKey(key);
      return parsed ? parsed.chatId === alias.chatId : key === alias.chatId;
    });

    if (!hasMatchingKey) {
      this.sessionAliases.delete(sessionId);
      return undefined;
    }

    console.log(`[Store] 命中会话别名: session=${sessionId} -> chat=${alias.chatId}`);
    return alias.chatId;
  }

  private cleanupExpiredSessionAliases(): void {
    const now = Date.now();
    for (const [sessionId, alias] of this.sessionAliases.entries()) {
      const hasMatchingKey = Array.from(this.data.keys()).some(key => {
        const parsed = this.parseConversationKey(key);
        return parsed ? parsed.chatId === alias.chatId : key === alias.chatId;
      });
      if (alias.expiresAt <= now || !hasMatchingKey) {
        this.sessionAliases.delete(sessionId);
      }
    }
  }

  /**
   * 设置会话（平台感知版本）
   * @param platform 平台标识
   * @param conversationId 平台原生会话 ID
   * @param sessionId 会话 ID
   * @param creatorId 创建者 ID
   * @param title 会话标题
   * @param options 绑定选项
   */
  setSessionByConversation(
    platform: string,
    conversationId: string,
    sessionId: string,
    creatorId: string,
    title?: string,
    options?: SessionBindingOptions
  ): void {
    const key = this.makeConversationKey(platform, conversationId);
    this.cleanupExpiredSessionAliases();

    const current = this.data.get(key);

    if (current?.sessionId && current.sessionId !== sessionId) {
      this.sessionAliases.set(current.sessionId, {
        chatId: conversationId,
        expiresAt: Date.now() + SESSION_ALIAS_TTL_MS,
      });
      console.log(`[Store] 创建会话别名: session=${current.sessionId} -> chat=${conversationId} (platform: ${platform})`);
    }
    this.sessionAliases.delete(sessionId);

    const resolvedChatType =
      options?.chatType
      || current?.chatType
      || this.inferChatTypeFromTitle(title)
      || this.inferChatTypeFromTitle(current?.title);

    const data: ChatSessionData = {
      chatId: conversationId,
      sessionId,
      ...(options?.sessionDirectory?.trim() ? { sessionDirectory: options.sessionDirectory.trim() } : {}),
      creatorId,
      createdAt: Date.now(),
      title,
      ...(resolvedChatType ? { chatType: resolvedChatType } : {}),
      ...(options?.protectSessionDelete ? { protectSessionDelete: true } : {}),
      ...(options?.resolvedDirectory ? { resolvedDirectory: options.resolvedDirectory } : {}),
      ...(options?.projectName ? { projectName: options.projectName } : {}),
      ...(current?.defaultDirectory ? { defaultDirectory: current.defaultDirectory } : {}),
      ...(current?.preferredModel ? { preferredModel: current.preferredModel } : {}),
      ...((() => {
        const a = normalizeAgentName(current?.preferredAgent);
        return a ? { preferredAgent: a } : {};
      })()),
      ...(current?.preferredEffort ? { preferredEffort: current.preferredEffort } : {}),
      ...(current?.recentModelIds && current.recentModelIds.length > 0
        ? { recentModelIds: [...current.recentModelIds] }
        : {}),
      interactionHistory: [],
    };

    this.data.set(key, data);
    this.save();
    console.log(`[Store] 绑定成功: platform=${platform}, conversation=${conversationId} -> session=${sessionId}`);
  }

  /**
   * 旧版 setSession（兼容 Feishu 调用方）
   * 写入时使用命名空间键（feishu 为默认平台）
   */
  setSession(
    chatId: string,
    sessionId: string,
    creatorId: string,
    title?: string,
    options?: SessionBindingOptions
  ): void {
    this.cleanupExpiredSessionAliases();

    const namespacedKey = this.legacyToNamespacedKey(chatId);
    const current = this.getChatDataLegacyOrNamespaced(chatId);

    if (current?.sessionId && current.sessionId !== sessionId) {
      this.sessionAliases.set(current.sessionId, {
        chatId,
        expiresAt: Date.now() + SESSION_ALIAS_TTL_MS,
      });
      console.log(`[Store] 创建会话别名: session=${current.sessionId} -> chat=${chatId}`);
    }
    this.sessionAliases.delete(sessionId);

    const resolvedChatType =
      options?.chatType
      || current?.chatType
      || this.inferChatTypeFromTitle(title)
      || this.inferChatTypeFromTitle(current?.title);

    const data: ChatSessionData = {
      chatId,
      sessionId,
      ...(options?.sessionDirectory?.trim() ? { sessionDirectory: options.sessionDirectory.trim() } : {}),
      creatorId,
      createdAt: Date.now(),
      title,
      ...(resolvedChatType ? { chatType: resolvedChatType } : {}),
      ...(options?.protectSessionDelete ? { protectSessionDelete: true } : {}),
      ...(options?.resolvedDirectory ? { resolvedDirectory: options.resolvedDirectory } : {}),
      ...(options?.projectName ? { projectName: options.projectName } : {}),
      ...(current?.defaultDirectory ? { defaultDirectory: current.defaultDirectory } : {}),
      ...(current?.preferredModel ? { preferredModel: current.preferredModel } : {}),
      ...((() => {
        const a = normalizeAgentName(current?.preferredAgent);
        return a ? { preferredAgent: a } : {};
      })()),
      ...(current?.preferredEffort ? { preferredEffort: current.preferredEffort } : {}),
      ...(current?.recentModelIds && current.recentModelIds.length > 0
        ? { recentModelIds: [...current.recentModelIds] }
        : {}),
      interactionHistory: [],
    };

    this.data.set(namespacedKey, data);
    this.save();
    console.log(`[Store] 绑定成功: chat=${chatId} (namespaced: ${namespacedKey}) -> session=${sessionId}`);
  }

  rememberSessionAlias(sessionId: string, chatId: string, ttlMs: number = SESSION_ALIAS_TTL_MS): void {
    const normalizedSessionId = sessionId.trim();
    const normalizedChatId = chatId.trim();
    if (!normalizedSessionId || !normalizedChatId) {
      return;
    }

    this.cleanupExpiredSessionAliases();
    const chat = this.getChatDataLegacyOrNamespaced(normalizedChatId);
    if (!chat) {
      return;
    }

    if (chat.sessionId === normalizedSessionId) {
      return;
    }

    const safeTtl = Number.isFinite(ttlMs) ? Math.max(60000, Math.floor(ttlMs)) : SESSION_ALIAS_TTL_MS;
    this.sessionAliases.set(normalizedSessionId, {
      chatId: normalizedChatId,
      expiresAt: Date.now() + safeTtl,
    });
    console.log(`[Store] 记录临时会话别名: session=${normalizedSessionId} -> chat=${normalizedChatId}`);
  }

  isSessionDeleteProtected(chatId: string): boolean {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    return session?.protectSessionDelete === true;
  }

  isPrivateChatSession(chatId: string): boolean {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (!session) {
      return false;
    }

    if (session.chatType === 'p2p') {
      return true;
    }

    return typeof session.title === 'string' && (session.title.startsWith('飞书私聊') || session.title.startsWith('私聊-'));
  }

  isGroupChatSession(chatId: string): boolean {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (!session) {
      return false;
    }

    if (session.chatType === 'group') {
      return true;
    }

    if (session.chatType === 'p2p') {
      return false;
    }

    if (typeof session.title !== 'string') {
      return false;
    }

    return session.title.startsWith('飞书群聊') || session.title.startsWith('群聊-') || session.title.startsWith('群聊会话');
  }

  updateConfig(
    chatId: string,
    config: {
      preferredModel?: string;
      preferredAgent?: string;
      preferredEffort?: EffortLevel;
      defaultDirectory?: string;
    }
  ): void {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (!session) return;

    if ('preferredModel' in config) {
      if (config.preferredModel) {
        session.preferredModel = config.preferredModel;
      } else {
        delete session.preferredModel;
      }
    }

    if ('preferredAgent' in config) {
      const normalizedAgent = normalizeAgentName(config.preferredAgent);
      if (normalizedAgent) {
        session.preferredAgent = normalizedAgent;
      } else {
        delete session.preferredAgent;
      }
    }

    if ('preferredEffort' in config) {
      if (config.preferredEffort) {
        session.preferredEffort = config.preferredEffort;
      } else {
        delete session.preferredEffort;
      }
    }

    if ('defaultDirectory' in config) {
      if (config.defaultDirectory) {
        session.defaultDirectory = config.defaultDirectory;
      } else {
        delete session.defaultDirectory;
      }
    }
    this.save();
  }

  updateConfigByConversation(
    platform: string,
    conversationId: string,
    config: {
      preferredModel?: string;
      preferredAgent?: string;
      preferredEffort?: EffortLevel;
      defaultDirectory?: string;
    }
  ): void {
    const session = this.getSessionByConversation(platform, conversationId);
    if (!session) return;

    if ('preferredModel' in config) {
      if (config.preferredModel) {
        session.preferredModel = config.preferredModel;
      } else {
        delete session.preferredModel;
      }
    }

    if ('preferredAgent' in config) {
      const normalizedAgent = normalizeAgentName(config.preferredAgent);
      if (normalizedAgent) {
        session.preferredAgent = normalizedAgent;
      } else {
        delete session.preferredAgent;
      }
    }

    if ('preferredEffort' in config) {
      if (config.preferredEffort) {
        session.preferredEffort = config.preferredEffort;
      } else {
        delete session.preferredEffort;
      }
    }

    if ('defaultDirectory' in config) {
      if (config.defaultDirectory) {
        session.defaultDirectory = config.defaultDirectory;
      } else {
        delete session.defaultDirectory;
      }
    }

    this.save();
  }

  updateTitle(chatId: string, title: string): void {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (session) {
      session.title = title;
      this.save();
    }
  }

  updateResolvedDirectory(chatId: string, directory: string): void {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (session) {
      session.resolvedDirectory = directory;
      this.save();
    }
  }

  /**
   * 读取本群是否处于 bot 对谈模式。
   * 存储独立于会话生命周期（见 bot-dialog-mode.ts）：重启/会话重绑不会丢失该标志。
   */
  isBotDialogMode(chatId: string): boolean {
    return botDialogModeStore.isEnabled(chatId);
  }

  /**
   * 切换本群 bot 对谈模式，返回设置后的值；群未绑定会话返回 null（供上层提示）。
   * 标志本身写入独立 store，不随会话记录被替换而丢失。
   */
  setBotDialogMode(chatId: string, enabled: boolean): boolean | null {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (!session) return null;
    botDialogModeStore.set(chatId, enabled);
    return enabled;
  }

  /** 读取当前 bot↔bot 连续接力轮数（无会话或未计数时返回 0）。 */
  getBotRelayRounds(chatId: string): number {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    return session?.botRelayRounds ?? 0;
  }

  /**
   * 白名单 bot 触发时调用，往返轮数 +1 并返回新值。
   * 若距上次接力已超过 cooldownMs（>0 时生效），先视为新对话归零再计数。
   */
  incrementBotRelayRounds(chatId: string, cooldownMs = 0): number {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (!session) return 0;
    const now = Date.now();
    const last = session.lastBotRelayAt ?? 0;
    if (cooldownMs > 0 && last > 0 && now - last > cooldownMs) {
      session.botRelayRounds = 0;
    }
    session.botRelayRounds = (session.botRelayRounds ?? 0) + 1;
    session.lastBotRelayAt = now;
    this.save();
    return session.botRelayRounds;
  }

  /** owner 真人发言时调用，清零接力计数（已为 0 则跳过持久化）。 */
  resetBotRelayRounds(chatId: string): void {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (session && (session.botRelayRounds ?? 0) !== 0) {
      session.botRelayRounds = 0;
      this.save();
    }
  }

  private static readonly MAX_RECENT_MODELS = 8;

  /** 记录最近选用的模型（去重、置顶），供面板优先展示 */
  pushRecentModel(chatId: string, modelValue: string): void {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (!session) return;
    const normalized = modelValue.trim();
    if (!normalized) return;
    const prev = session.recentModelIds || [];
    const next = [normalized, ...prev.filter(v => v !== normalized)].slice(0, ChatSessionStore.MAX_RECENT_MODELS);
    session.recentModelIds = next;
    this.save();
  }

  private updateLegacyPointers(session: ChatSessionData): void {
    let lastUserMsgId: string | undefined;
    for (let i = session.interactionHistory.length - 1; i >= 0; i--) {
      const msgId = session.interactionHistory[i].userFeishuMsgId;
      if (msgId) {
        lastUserMsgId = msgId;
        break;
      }
    }

    let lastAiMsgId: string | undefined;
    for (let i = session.interactionHistory.length - 1; i >= 0; i--) {
      const msgIds = session.interactionHistory[i].botFeishuMsgIds;
      if (msgIds.length > 0) {
        lastAiMsgId = msgIds[msgIds.length - 1];
        break;
      }
    }

    session.lastFeishuUserMsgId = lastUserMsgId;
    session.lastFeishuAiMsgId = lastAiMsgId;
  }

  addInteraction(chatId: string, record: InteractionRecord): void {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (!session) {
      console.debug(`[Store] addInteraction 跳过：会话不存在 chatId=${chatId?.slice(0, 16)}...`);
      return;
    }
    if (!session.interactionHistory) {
      session.interactionHistory = [];
    }
    session.interactionHistory.push(record);
    this.updateLegacyPointers(session);
    if (session.interactionHistory.length > 20) {
      session.interactionHistory.shift();
      this.updateLegacyPointers(session);
    }
    this.save();
  }

  popInteraction(chatId: string): InteractionRecord | undefined {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (session && session.interactionHistory && session.interactionHistory.length > 0) {
      const record = session.interactionHistory.pop();

      this.updateLegacyPointers(session);
      this.save();
      return record;
    }
    return undefined;
  }

  getLastInteraction(chatId: string): InteractionRecord | undefined {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (session && session.interactionHistory && session.interactionHistory.length > 0) {
      return session.interactionHistory[session.interactionHistory.length - 1];
    }
    return undefined;
  }

  findInteractionByBotMsgId(chatId: string, msgId: string): InteractionRecord | undefined {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (!session || !session.interactionHistory) return undefined;
    return session.interactionHistory.find(r => r.botFeishuMsgIds.includes(msgId));
  }

  findInteractionByUserMsgId(chatId: string, msgId: string): InteractionRecord | undefined {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (!session || !session.interactionHistory) return undefined;
    return session.interactionHistory.find(r => r.userFeishuMsgId === msgId);
  }

  updateInteraction(chatId: string, predicate: (r: InteractionRecord) => boolean, updater: (r: InteractionRecord) => void): void {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (session && session.interactionHistory) {
      const record = session.interactionHistory.find(predicate);
      if (record) {
        updater(record);
        this.save();
      }
    }
  }

  updateLastInteraction(chatId: string, userMsgId: string, aiMsgId?: string): void {
    const session = this.getChatDataLegacyOrNamespaced(chatId);
    if (session) {
      session.lastFeishuUserMsgId = userMsgId;
      if (aiMsgId) {
        session.lastFeishuAiMsgId = aiMsgId;
      }
      this.save();
    }
  }

  removeSession(chatId: string): void {
    const namespacedKey = this.legacyToNamespacedKey(chatId);

    if (this.data.has(namespacedKey)) {
      const session = this.data.get(namespacedKey);
      if (session?.sessionId) {
        for (const [sid, alias] of this.sessionAliases.entries()) {
          if (alias.chatId === chatId) {
            this.sessionAliases.delete(sid);
          }
        }
      }
      this.data.delete(namespacedKey);
      this.save();
      console.log(`[Store] 移除绑定 (namespaced): chat=${chatId} -> ${namespacedKey}`);
      return;
    }

    if (this.data.has(chatId)) {
      for (const [sessionId, alias] of this.sessionAliases.entries()) {
        if (alias.chatId === chatId) {
          this.sessionAliases.delete(sessionId);
        }
      }
      this.data.delete(chatId);
      this.save();
      console.log(`[Store] 移除绑定 (legacy): chat=${chatId}`);
    }
  }

  removeSessionByConversation(platform: string, conversationId: string): void {
    const key = this.makeConversationKey(platform, conversationId);
    if (!this.data.has(key)) {
      return;
    }

    const existing = this.data.get(key);
    if (existing?.sessionId) {
      this.sessionAliases.delete(existing.sessionId);
    }

    this.data.delete(key);
    this.save();
    console.log(`[Store] 移除绑定 (platform): ${platform}:${conversationId}`);
  }

  markReminderSent(platform: string, conversationId: string): void {
    const session = this.getSessionByConversation(platform, conversationId);
    if (!session) return;

    session.reminderSent = true;
    this.save();
  }

  getChatsByCreator(userId: string): ChatSessionData[] {
    const result: ChatSessionData[] = [];
    for (const data of this.data.values()) {
      if (data.creatorId === userId) {
        result.push(data);
      }
    }
    return result;
  }

  getAllChatIds(): string[] {
    return Array.from(this.data.keys()).map(key => {
      const parsed = this.parseConversationKey(key);
      if (parsed) {
        return parsed.chatId;
      }
      return key;
    });
  }

  /**
   * 获取指定平台的所有会话 ID
   * @param platform 平台标识（如 'feishu', 'discord'）
   * @returns 该平台所有会话的 chatId 列表
   */
  getChatIdsByPlatform(platform: string): string[] {
    const result: string[] = [];
    for (const key of this.data.keys()) {
      const parsed = this.parseConversationKey(key);
      if (parsed && parsed.platform === platform) {
        result.push(parsed.chatId);
      }
    }
    return result;
  }

  getAllSessions(): Array<ChatSessionData & { chatId: string }> {
    const results: Array<ChatSessionData & { chatId: string }> = [];
    for (const [key, data] of this.data.entries()) {
      const parsed = this.parseConversationKey(key);
      const chatId = parsed ? parsed.chatId : key;
      results.push({ ...data, chatId });
    }
    return results;
  }

  setCompacting(sessionId: string, compacting: boolean): void {
    if (compacting) {
      this.compactingSessionIds.add(sessionId);
    } else {
      this.compactingSessionIds.delete(sessionId);
    }
  }

  isCompacting(sessionId: string): boolean {
    return this.compactingSessionIds.has(sessionId);
  }

  hasConversationId(conversationId: string): boolean {
    for (const key of this.data.keys()) {
      const parsed = this.parseConversationKey(key);
      if (parsed) {
        if (parsed.chatId === conversationId) {
          return true;
        }
        continue;
      }

      if (key === conversationId) {
        return true;
      }
    }
    return false;
  }

}

export const chatSessionStore = new ChatSessionStore();
