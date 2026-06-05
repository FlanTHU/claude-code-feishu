// AI 后端抽象接口
// 把 opencodeClient 的对外契约固化成接口,使 opencode / claude code 等后端可切换共存。
//
// 设计原则:
// - 核心方法(两后端都必须实现)不带 `?`。
// - opencode 专有 / 可降级的方法标 `?` 可选,claude 后端可不实现;
//   调用方(如 command.ts)在使用前做存在性检查来降级。
// - 事件契约见文件末尾 BACKEND_EVENTS 说明;后端均 extends EventEmitter,
//   emit 这些事件,event-hub 统一监听。
//
// 注:核心方法的返回类型沿用 opencode SDK 的 Session/Message/Part,
// 以保证 event-hub / handlers 下游零改动;claude 后端负责构造结构兼容的对象。

import type { EventEmitter } from 'events';
import type { Session, Message, Part, Project } from '@opencode-ai/sdk';
import type {
  PermissionRequestEvent,
  PermissionResponseOptions,
  ShellExecutionResult,
  SessionQueryOptions,
  OpencodeRuntimeConfig,
  OpencodeAgentInfo,
} from '../opencode/client.js';

export type { PermissionRequestEvent, PermissionResponseOptions };

/** 后端标识 */
export type BackendId = 'opencode' | 'claude';

/** 发送消息的可选项(provider/model/agent/工作目录) */
export interface BackendSendOptions {
  providerId?: string;
  modelId?: string;
  agent?: string;
  variant?: string;
  directory?: string;
}

/** 多 part 消息内容 */
export type BackendMessagePart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string }
  | { type: 'file-path'; filePath: string; filename: string };

/**
 * AI 后端抽象接口。
 * 实现者须 extends EventEmitter,并 emit BACKEND_EVENTS 中列出的事件。
 */
export interface AiBackend extends EventEmitter {
  // ── 连接生命周期 ────────────────────────────────────────────
  connect(): Promise<boolean>;
  getConnectionStatus(): { connected: boolean; lastHeartbeatAt: number };
  disconnect(): void;

  // ── 消息收发(主链路,fire-and-forget,结果走事件流) ────────
  sendMessageAsync(sessionId: string, text: string, options?: BackendSendOptions): Promise<void>;
  sendMessagePartsAsync(
    sessionId: string,
    parts: BackendMessagePart[],
    options?: BackendSendOptions
  ): Promise<void>;

  // ── 会话控制 ────────────────────────────────────────────────
  abortSession(sessionId: string): Promise<boolean>;
  respondToPermission(
    sessionId: string,
    permissionId: string,
    allow: boolean,
    remember?: boolean,
    options?: PermissionResponseOptions
  ): Promise<boolean>;

  // ── 会话管理 ────────────────────────────────────────────────
  createSession(title?: string, directory?: string): Promise<Session>;
  getOrCreateSession(title?: string): Promise<Session>;
  getSessionById(sessionId: string, options?: SessionQueryOptions): Promise<Session | null>;
  getSessionMessages(sessionId: string): Promise<Array<{ info: Message; parts: Part[] }>>;
  deleteSession(sessionId: string, options?: SessionQueryOptions): Promise<boolean>;
  updateSession(sessionId: string, title: string): Promise<boolean>;

  // ── 同步发送(部分命令链路使用) ──────────────────────────
  sendMessage(
    sessionId: string,
    text: string,
    options?: BackendSendOptions
  ): Promise<{ info: Message; parts: Part[] }>;
  sendMessageParts(
    sessionId: string,
    parts: BackendMessagePart[],
    options?: BackendSendOptions,
    messageId?: string
  ): Promise<{ info: Message; parts: Part[] }>;

  // ── opencode 专有方法 ───────────────────────────────────────
  // 两后端都实现以满足接口;Claude 后端为降级实现(返回空值/不支持提示)。
  // 调用方若需区分"真实数据 vs 降级",用 activeBackendId 判断后端类型。
  sendCommand(
    sessionId: string,
    command: string,
    args: string,
    options?: { directory?: string; providerId?: string; modelId?: string }
  ): Promise<{ info: Message; parts: Part[] }>;
  sendShellCommand(
    sessionId: string,
    command: string,
    agent: string,
    options?: { providerId?: string; modelId?: string; directory?: string }
  ): Promise<ShellExecutionResult>;
  summarizeSession(sessionId: string, providerId: string, modelId: string): Promise<boolean>;
  revertMessage(sessionId: string, messageId: string): Promise<boolean>;
  replyQuestion(requestId: string, answers: string[][]): Promise<boolean>;
  rejectQuestion(requestId: string): Promise<boolean>;

  listProjects(options?: SessionQueryOptions): Promise<Project[]>;
  listSessions(options?: SessionQueryOptions): Promise<Session[]>;
  listSessionsAcrossProjects(): Promise<Session[]>;
  listAllSessions(knownDirectories: string[]): Promise<Session[]>;
  findSessionAcrossProjects(sessionId: string): Promise<Session | null>;

  getProviders(): Promise<{
    providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
    default: Record<string, string>;
  }>;
  getConfig(): Promise<OpencodeRuntimeConfig>;
  updateConfig(config: OpencodeRuntimeConfig): Promise<OpencodeRuntimeConfig | null>;
  getAgents(): Promise<OpencodeAgentInfo[]>;
}

/**
 * 后端 emit 的事件契约(供 event-hub 监听、claude 后端复刻)。
 * payload 形状与 opencodeClient 现有 emit 保持一致:
 *
 *   permissionRequest   → PermissionRequestEvent
 *   messageUpdated      → Record<string, unknown>  (event.properties 原样)
 *   sessionUpdated      → Record<string, unknown>
 *   sessionStatus       → Record<string, unknown>
 *   sessionIdle         → Record<string, unknown>
 *   sessionError        → Record<string, unknown>
 *   messagePartUpdated  → Record<string, unknown>  (含 part: {sessionID,messageID,type,id})
 *   questionAsked       → Record<string, unknown>
 */
export const BACKEND_EVENTS = [
  'permissionRequest',
  'messageUpdated',
  'sessionUpdated',
  'sessionStatus',
  'sessionIdle',
  'sessionError',
  'messagePartUpdated',
  'questionAsked',
] as const;

export type BackendEventName = (typeof BACKEND_EVENTS)[number];
