// Claude Code(Agent SDK)后端 —— 实现 AiBackend 接口,与 opencodeClient 平级可切换。
//
// 核心设计(详见 docs/claude-code-backend-research.md):
// - 会话:bridge 用自生成的 sessionId 标识会话;首次发消息后记录 Agent SDK 的真实
//   session_id,后续轮次用 resume 续接,保持上下文。
// - 流式:消费 query() 的 stream_event / assistant / result,转译成 bridge 事件
//   (messagePartUpdated / messageUpdated / sessionIdle / sessionError),
//   payload 形状与 opencodeClient 完全一致,event-hub 零改动。
// - 权限:用 PreToolUse hook(canUseTool 在 mify→Bedrock 链路下不触发,实测见文档),
//   hook 内 emit permissionRequest 并挂起 Promise,respondToPermission 时 resolve。
// - opencode 专有方法(getProviders/getAgents/listProjects/sendCommand 等)不实现,
//   接口里它们是可选的;command.ts 在调用前做存在性检查降级。

import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import {
  query,
  type Query,
  type PermissionResult,
  type SDKUserMessage,
  type PreToolUseHookInput,
  type HookJSONOutput,
  type McpStdioServerConfig,
} from '@anthropic-ai/claude-agent-sdk';
import type { Session, Message, Part, Project } from '@opencode-ai/sdk';
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type {
  OpencodeRuntimeConfig,
  OpencodeAgentInfo,
  ShellExecutionResult,
} from '../opencode/client.js';
import { claudeConfig, loadClaudeSystemPrompt, resolveMifyApiKey } from '../config.js';
import type {
  AiBackend,
  BackendSendOptions,
  BackendMessagePart,
  PermissionResponseOptions,
} from '../backend/types.js';
import type { PermissionRequestEvent, SessionQueryOptions } from '../opencode/client.js';

// 单条会话的运行时状态
interface ClaudeSession {
  bridgeSessionId: string; // bridge 侧标识(对外 sessionId)
  claudeSessionId?: string; // Agent SDK 真实 session_id,用于 resume
  title: string;
  directory: string;
  createdAt: number;
  updatedAt: number;
  activeQuery?: Query; // 当前进行中的 query,用于 abort
  abortController?: AbortController;
  rememberedTools: Set<string>; // 用户选「始终允许」记住的工具名,后续同工具直接放行
}

// 挂起的权限请求:hook 等待飞书侧回调
interface PendingPermission {
  resolve: (result: PermissionResult) => void;
  timer: NodeJS.Timeout;
  sessionId: string;
  tool: string; // 工具名,用于 remember 时记入 session.rememberedTools
}

class ClaudeClientWrapper extends EventEmitter implements AiBackend {
  private sessions = new Map<string, ClaudeSession>();
  private pendingPermissions = new Map<string, PendingPermission>();
  private connected = false;
  private lastHeartbeatAt = 0;
  // 人格/交互约束系统提示(启动时加载一次,append 到 claude_code preset)
  private systemPrompt: string | undefined;
  // hmem MCP 配置(启动时构建一次;key 取不到或开关关闭则为空,不接入)
  private mcpServers: Record<string, McpStdioServerConfig> = {};

  // ── 连接生命周期 ──────────────────────────────────────────
  async connect(): Promise<boolean> {
    // Agent SDK 无常驻连接,这里只校验鉴权环境变量是否就绪
    if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_USE_BEDROCK) {
      console.error('[Claude] 缺少 ANTHROPIC_API_KEY(或 Bedrock 等第三方鉴权环境变量)');
      return false;
    }
    this.systemPrompt = loadClaudeSystemPrompt();
    this.mcpServers = this.buildMcpServers();
    this.connected = true;
    this.lastHeartbeatAt = Date.now();
    console.log(
      `[Claude] 已就绪 model=${claudeConfig.model ?? '(SDK 默认)'} cwd=${claudeConfig.cwd} ` +
        `baseUrl=${process.env.ANTHROPIC_BASE_URL ?? '(官方)'} ` +
        `systemPrompt=${this.systemPrompt ? `${this.systemPrompt.length} 字符` : '无'} ` +
        `mcp=${Object.keys(this.mcpServers).join(',') || '无'}`
    );
    return true;
  }

  getConnectionStatus(): { connected: boolean; lastHeartbeatAt: number } {
    return { connected: this.connected, lastHeartbeatAt: this.lastHeartbeatAt };
  }

  // 构建 hmem MCP server 配置(stdio)。开关关闭、CLI 不存在或 key 取不到时
  // 返回空对象(软降级,不接入 hmem,不影响其余功能)。
  private buildMcpServers(): Record<string, McpStdioServerConfig> {
    const h = claudeConfig.hmem;
    if (!h.enabled) return {};
    if (!fs.existsSync(h.cli)) {
      console.warn(`[Claude] hmem 已启用但 CLI 不存在,跳过接入: ${h.cli}`);
      return {};
    }
    const mifyApiKey = resolveMifyApiKey();
    if (!mifyApiKey) {
      console.warn('[Claude] hmem 已启用但取不到 MIFY_API_KEY(环境变量/keychain 均无),跳过接入');
      return {};
    }
    return {
      hmem: {
        type: 'stdio',
        command: h.nodeBin,
        args: [h.cli, 'serve'],
        env: {
          HMEM_PROJECT_DIR: h.projectDir,
          MIFY_API_KEY: mifyApiKey,
          ...(h.ollamaDisabled ? { HMEM_OLLAMA_DISABLED: 'true' } : {}),
        },
      },
    };
  }

  disconnect(): void {
    for (const s of this.sessions.values()) {
      s.abortController?.abort();
    }
    for (const p of this.pendingPermissions.values()) {
      clearTimeout(p.timer);
      p.resolve({ behavior: 'deny', message: '服务关闭' });
    }
    this.pendingPermissions.clear();
    this.connected = false;
  }

  // ── 会话管理 ──────────────────────────────────────────────
  async createSession(title?: string, directory?: string): Promise<Session> {
    const id = `claude-${randomUUID()}`;
    const now = Date.now();
    const session: ClaudeSession = {
      bridgeSessionId: id,
      title: title || '新对话',
      directory: directory || claudeConfig.cwd,
      createdAt: now,
      updatedAt: now,
      rememberedTools: new Set(),
    };
    this.sessions.set(id, session);
    return this.toOpencodeSession(session);
  }

  async getOrCreateSession(title?: string): Promise<Session> {
    return this.createSession(title);
  }

  async getSessionById(sessionId: string, _options?: SessionQueryOptions): Promise<Session | null> {
    const s = this.sessions.get(sessionId);
    return s ? this.toOpencodeSession(s) : null;
  }

  async getSessionMessages(_sessionId: string): Promise<Array<{ info: Message; parts: Part[] }>> {
    // Agent SDK 的历史存于本地 JSONL,bridge 不直接读取;返回空表示不支持回溯
    return [];
  }

  async deleteSession(sessionId: string, _options?: SessionQueryOptions): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.abortController?.abort();
      this.sessions.delete(sessionId);
    }
    return true;
  }

  async updateSession(sessionId: string, title: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    s.title = title.trim() || s.title;
    s.updatedAt = Date.now();
    return true;
  }

  // ── 消息收发(主链路) ─────────────────────────────────────
  async sendMessageAsync(sessionId: string, text: string, options?: BackendSendOptions): Promise<void> {
    await this.runQuery(sessionId, text, options);
  }

  async sendMessagePartsAsync(
    sessionId: string,
    parts: BackendMessagePart[],
    options?: BackendSendOptions
  ): Promise<void> {
    // 转成 Anthropic content blocks(支持多模态):
    // - text: text block
    // - file(图片 data url): image block,真正喂给模型看图
    // - file(其他 data url): 占位文本(claude 后端暂不解析非图片二进制)
    // - file-path: 文本路径提示,claude 用 Read 工具自行读取
    const blocks: ContentBlockParam[] = [];
    for (const p of parts) {
      if (p.type === 'text') {
        blocks.push({ type: 'text', text: p.text });
      } else if (p.type === 'file-path') {
        blocks.push({
          type: 'text',
          text: `[附件文件] 文件名: ${p.filename}\n文件路径: ${p.filePath}\n(请用 Read 工具读取该文件)`,
        });
      } else {
        const image = this.toImageBlock(p.mime, p.url);
        if (image) {
          blocks.push(image);
        } else {
          blocks.push({
            type: 'text',
            text: `[附件 ${p.filename ?? p.url} (${p.mime}) — 当前后端暂不支持解析此类附件]`,
          });
        }
      }
    }
    await this.runQuery(sessionId, blocks, options);
  }

  // 把飞书图片 part(data url 或裸 url)转成 Anthropic image block;非图片返回 null
  private toImageBlock(mime: string, url: string): ContentBlockParam | null {
    const supported = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (!supported.includes(mime)) return null;
    const mediaType = mime as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
    // data url: data:image/jpeg;base64,xxxx
    const m = url.match(/^data:[^;]+;base64,(.+)$/);
    if (m) {
      return { type: 'image', source: { type: 'base64', media_type: mediaType, data: m[1] } };
    }
    if (/^https?:\/\//.test(url)) {
      return { type: 'image', source: { type: 'url', url } };
    }
    return null;
  }

  // ── 会话控制 ──────────────────────────────────────────────
  async abortSession(sessionId: string): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s?.abortController) return false;
    s.abortController.abort();
    return true;
  }

  async respondToPermission(
    sessionId: string,
    permissionId: string,
    allow: boolean,
    remember?: boolean,
    _options?: PermissionResponseOptions
  ): Promise<boolean> {
    const pending = this.pendingPermissions.get(permissionId);
    if (!pending) {
      console.warn(`[Claude] respondToPermission: 未找到挂起的权限请求 ${permissionId}`);
      return false;
    }
    clearTimeout(pending.timer);
    this.pendingPermissions.delete(permissionId);
    // 「始终允许」:记住该工具,后续同会话同工具直接放行,不再弹卡片
    if (allow && remember) {
      const session = this.sessions.get(pending.sessionId);
      session?.rememberedTools.add(pending.tool);
      console.log(`[Claude] 已记住工具 ${pending.tool}(会话 ${pending.sessionId} 后续自动放行)`);
    }
    pending.resolve(
      allow ? { behavior: 'allow', updatedInput: undefined } : { behavior: 'deny', message: '用户拒绝' }
    );
    return true;
  }

  // ── opencode 专有方法的降级实现 ───────────────────────────
  // Claude 后端无 provider/agent/跨 project session 等概念,这些方法返回
  // 安全的空值/不支持提示,使依赖它们的命令优雅降级而非崩溃。
  private warnUnsupported(method: string): void {
    console.warn(`[Claude] 方法 ${method} 在 Claude 后端不支持,已降级`);
  }

  async sendMessage(sessionId: string, text: string, options?: BackendSendOptions): Promise<{ info: Message; parts: Part[] }> {
    // Claude 后端走异步事件流,同步返回值不适用;触发异步处理后返回空壳
    await this.sendMessageAsync(sessionId, text, options);
    return { info: {} as Message, parts: [] };
  }

  async sendMessageParts(
    sessionId: string,
    parts: BackendMessagePart[],
    options?: BackendSendOptions
  ): Promise<{ info: Message; parts: Part[] }> {
    await this.sendMessagePartsAsync(sessionId, parts, options);
    return { info: {} as Message, parts: [] };
  }

  async sendCommand(): Promise<{ info: Message; parts: Part[] }> {
    this.warnUnsupported('sendCommand');
    return { info: {} as Message, parts: [] };
  }

  async sendShellCommand(): Promise<ShellExecutionResult> {
    this.warnUnsupported('sendShellCommand');
    return { parts: [] };
  }

  async summarizeSession(): Promise<boolean> {
    this.warnUnsupported('summarizeSession');
    return false;
  }

  async revertMessage(): Promise<boolean> {
    this.warnUnsupported('revertMessage');
    return false;
  }

  async replyQuestion(): Promise<boolean> {
    this.warnUnsupported('replyQuestion');
    return false;
  }

  async rejectQuestion(): Promise<boolean> {
    this.warnUnsupported('rejectQuestion');
    return false;
  }

  async listProjects(): Promise<Project[]> {
    return [];
  }

  async listSessions(): Promise<Session[]> {
    return Array.from(this.sessions.values()).map((s) => this.toOpencodeSession(s));
  }

  async listSessionsAcrossProjects(): Promise<Session[]> {
    return this.listSessions();
  }

  async listAllSessions(): Promise<Session[]> {
    return this.listSessions();
  }

  async findSessionAcrossProjects(sessionId: string): Promise<Session | null> {
    return this.getSessionById(sessionId);
  }

  async getProviders(): Promise<{
    providers: Array<{ id: string; name: string; models: Array<{ id: string; name: string }> }>;
    default: Record<string, string>;
  }> {
    // 暴露当前配置的单一模型,供面板显示
    const model = claudeConfig.model;
    if (!model) return { providers: [], default: {} };
    return {
      providers: [{ id: 'claude', name: 'Claude', models: [{ id: model, name: model }] }],
      default: { claude: model },
    };
  }

  async getConfig(): Promise<OpencodeRuntimeConfig> {
    return {};
  }

  async updateConfig(): Promise<OpencodeRuntimeConfig | null> {
    this.warnUnsupported('updateConfig');
    return null;
  }

  async getAgents(): Promise<OpencodeAgentInfo[]> {
    return [];
  }

  // 取会话,内存中不存在则按需懒注册。
  // claudeClient 会话状态仅在内存,而 bridge 的 sessionId 是持久化的;
  // 服务重启或外部派生 sessionId 时,内存可能没有对应记录。此时当作
  // 新 Claude 对话开始(无 resume,丢失历史上下文,但能正常应答而非空回复)。
  private ensureSession(sessionId: string): ClaudeSession {
    let session = this.sessions.get(sessionId);
    if (!session) {
      const now = Date.now();
      session = {
        bridgeSessionId: sessionId,
        title: '恢复的对话',
        directory: claudeConfig.cwd,
        createdAt: now,
        updatedAt: now,
        rememberedTools: new Set(),
      };
      this.sessions.set(sessionId, session);
      console.warn(`[Claude] 内存无会话 ${sessionId},已懒注册为新对话(无历史上下文)`);
    }
    return session;
  }

  // ── 内部:执行一轮 query 并把事件流转译为 bridge 事件 ─────────
  private async runQuery(
    sessionId: string,
    content: string | ContentBlockParam[],
    options?: BackendSendOptions
  ): Promise<void> {
    const session = this.ensureSession(sessionId);

    const abortController = new AbortController();
    session.abortController = abortController;
    session.updatedAt = Date.now();
    this.lastHeartbeatAt = Date.now();

    // 模型解析:优先 CLAUDE_MODEL/默认 opus(mify 认的格式)。
    // bridge 传来的 providerId/modelId 是 opencode 的 provider 概念
    // (如 "Mify-Claude1/pa/..."),mify 的 Anthropic 端点不认会返回
    // "400 Param Incorrect",故 Claude 后端忽略它,只用自己配置的模型。
    const model = this.resolveModel(options);

    let assistantMsgId = `msg-${randomUUID()}`;

    // 一轮 agentic query 会产生多条 assistant 消息(每次工具调用前后各一条)。
    // 去重键与 part.id 都以 SDK 的真实消息 id(message.id,如 msg_bdrk_...)为基:
    // 该 id 在「流式增量 stream_event」与「完整 assistant 消息」两条轨里恒等、跨轮唯一,
    // 两轨天然对齐。曾用自造 assistantMsgId+msgSeq+index 拼键,但流式的 event.index
    // (thinking 占 0、text 占 1)与完整消息数组下标(每条事件单块、下标恒 0)是两套编号,
    // 永不相等 → 去重必失效,同段文本被 emit 两遍(重复回复 bug,已实测复现)。
    // currentRealId 由 message_start 事件刷新,供其后的 content_block_delta 复用。
    let currentRealId = assistantMsgId;

    // 记录已通过 stream_event 流式发出的块,键 `t:${realId}:${index}` / `k:${realId}:${index}`
    // (t/k 区分 text/thinking),完整 assistant 消息到达时据此跳过,避免对同一文本重复 emit。
    const streamedKeys = new Set<string>();
    try {
      const q = query({
        prompt: this.singleUserMessage(content),
        options: {
          ...(model ? { model } : {}),
          cwd: session.directory,
          permissionMode: claudeConfig.permissionMode,
          includePartialMessages: true,
          abortController,
          // 人格/交互约束:保留 Claude Code preset 能力(工具等),叠加自定义内容
          ...(this.systemPrompt
            ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: this.systemPrompt } as const }
            : {}),
          ...(Object.keys(this.mcpServers).length ? { mcpServers: this.mcpServers } : {}),
          ...(session.claudeSessionId ? { resume: session.claudeSessionId } : {}),
          hooks: {
            PreToolUse: [
              {
                hooks: [(input) => this.handlePreToolUse(sessionId, input as PreToolUseHookInput)],
              },
            ],
          },
        },
      });
      session.activeQuery = q;

      for await (const msg of q) {
        this.lastHeartbeatAt = Date.now();

        if (msg.type === 'system') {
          if (msg.subtype === 'init') {
            // 记录真实 session_id 供下一轮 resume
            session.claudeSessionId = msg.session_id;
            this.emit('messageUpdated', {
              info: { sessionID: sessionId, role: 'assistant', id: assistantMsgId },
            });
          }
          continue;
        }

        // 流式增量:文本 / 思考(若该链路提供 partial messages)
        if (msg.type === 'stream_event') {
          // message_start 刷新真实消息 id,供其后 content_block_delta 建立去重键。
          const ev = msg.event as { type?: string; message?: { id?: string } };
          if (ev?.type === 'message_start' && ev.message?.id) {
            currentRealId = ev.message.id;
          }
          this.handleStreamEvent(sessionId, currentRealId, msg.event, streamedKeys);
          continue;
        }

        // 完整 assistant 消息:提取 text / thinking / tool_use 块。
        // 非流式链路(无 stream_event)下,文本只在这里出现,必须提取,
        // 否则会出现空回复(E2E 实测发现的 bug)。已流式发出的块按 realId+类型跳过避免重复。
        if (msg.type === 'assistant') {
          // 完整消息的 message.id 与流式轨的 realId 恒等,据此判定该块是否已流式发出。
          const realId = (msg.message as { id?: string })?.id || assistantMsgId;
          msg.message.content.forEach((block, index) => {
            if (typeof block !== 'object') return;
            if (block.type === 'text') {
              if (streamedKeys.has(`t:${realId}`)) return;
              streamedKeys.add(`t:${realId}`);
              this.emit('messagePartUpdated', {
                sessionID: sessionId,
                part: { type: 'text', id: `${realId}-${index}`, messageID: realId },
                delta: block.text,
              });
            } else if (block.type === 'thinking') {
              if (streamedKeys.has(`k:${realId}`)) return;
              streamedKeys.add(`k:${realId}`);
              this.emit('messagePartUpdated', {
                sessionID: sessionId,
                part: { type: 'reasoning', id: `${realId}-think-${index}`, messageID: realId },
                delta: block.thinking,
              });
            } else if (block.type === 'tool_use') {
              this.emit('messagePartUpdated', {
                sessionID: sessionId,
                part: {
                  type: 'tool',
                  tool: block.name,
                  callID: block.id,
                  id: block.id,
                  messageID: realId,
                  state: { status: 'running' },
                  input: block.input,
                },
              });
            }
          });
          continue;
        }

        // 工具结果回灌(user 消息里的 tool_result)→ 标记工具完成
        if (msg.type === 'user') {
          const content = msg.message.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (typeof block === 'object' && block.type === 'tool_result') {
                this.emit('messagePartUpdated', {
                  sessionID: sessionId,
                  part: {
                    type: 'tool',
                    callID: block.tool_use_id,
                    id: block.tool_use_id,
                    messageID: assistantMsgId,
                    state: { status: block.is_error ? 'failed' : 'completed' },
                    output: this.stringifyToolResult(block.content),
                  },
                });
              }
            }
          }
          continue;
        }

        if (msg.type === 'result') {
          if (msg.subtype !== 'success') {
            this.emit('sessionError', {
              sessionID: sessionId,
              error: { message: `执行结束: ${msg.subtype}` },
            });
          }
          // 一轮结束信号
          this.emit('sessionIdle', { sessionID: sessionId });
          break;
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : '';
      if (abortController.signal.aborted) {
        // 主动中止,不算错误
        this.emit('sessionIdle', { sessionID: sessionId });
      } else {
        console.error(`[Claude] query 失败 session=${sessionId}: ${message}\n${stack}`);
        this.emit('sessionError', { sessionID: sessionId, error: { message } });
      }
    } finally {
      session.activeQuery = undefined;
      session.abortController = undefined;
    }
  }

  // 流式增量事件:从 BetaRawMessageStreamEvent 提取 text/thinking delta。
  // 去重键以真实消息 id(realId)为基、按类型区分(t/k),不含 index:流式的 event.index
  // 与完整消息数组下标是两套编号(见 runQuery 注释),带 index 反而对不上;而一条逻辑
  // 消息内 text/thinking 各一块,realId 粒度已足以标识。part.id 保留 index 供下游区分块。
  private handleStreamEvent(
    sessionId: string,
    realId: string,
    event: BetaRawMessageStreamEvent,
    streamedKeys: Set<string>
  ): void {
    if (event.type !== 'content_block_delta') return;
    const delta = event.delta;
    const index = event.index;

    if (delta.type === 'text_delta') {
      streamedKeys.add(`t:${realId}`);
      this.emit('messagePartUpdated', {
        sessionID: sessionId,
        part: { type: 'text', id: `${realId}-${index}`, messageID: realId },
        delta: delta.text,
      });
    } else if (delta.type === 'thinking_delta') {
      streamedKeys.add(`k:${realId}`);
      this.emit('messagePartUpdated', {
        sessionID: sessionId,
        part: { type: 'reasoning', id: `${realId}-think-${index}`, messageID: realId },
        delta: delta.thinking,
      });
    }
  }

  // PreToolUse hook:emit permissionRequest 并挂起,等飞书侧 respondToPermission
  private async handlePreToolUse(
    sessionId: string,
    input: PreToolUseHookInput
  ): Promise<HookJSONOutput> {
    // bypassPermissions / acceptEdits 由 SDK 处理,这里只在 default 模式下交互
    if (claudeConfig.permissionMode !== 'default') {
      return {};
    }

    const tool = input.tool_name;

    // hmem 记忆工具(mcp__hmem__*):读写主人自己的记忆库,低风险且需高频自动调用,
    // 静默放行,否则每次 recall/store 都弹飞书卡片,"主动记忆"无从谈起。
    if (tool.startsWith('mcp__hmem__')) {
      return { decision: 'approve' };
    }

    // 用户已对本会话该工具选过「始终允许」→ 直接放行,不再弹卡片
    if (this.sessions.get(sessionId)?.rememberedTools.has(tool)) {
      return { decision: 'approve' };
    }

    const toolInput =
      input.tool_input && typeof input.tool_input === 'object'
        ? (input.tool_input as Record<string, unknown>)
        : undefined;
    const permissionId = `perm-${randomUUID()}`;
    const description = this.describeToolInput(tool, toolInput);

    const event: PermissionRequestEvent = {
      sessionId,
      permissionId,
      tool,
      description,
    };

    // 必须先登记 pending,再 emit。emit 是同步的:event-hub 的白名单
    // 自动放行会在 emit 调用栈内同步调用 respondToPermission,若此时
    // pending 尚未登记会"未找到挂起请求"而失败(E2E 实测的时序 bug)。
    const result = await new Promise<PermissionResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPermissions.delete(permissionId);
        resolve({ behavior: 'deny', message: '权限请求超时' });
      }, claudeConfig.permissionTimeoutMs);
      this.pendingPermissions.set(permissionId, { resolve, timer, sessionId, tool });
      this.emit('permissionRequest', event);
    });

    if (result.behavior === 'allow') {
      return { decision: 'approve' };
    }
    return { decision: 'block', reason: result.message ?? '已拒绝' };
  }

  // ── 工具方法 ──────────────────────────────────────────────
  private async *singleUserMessage(
    content: string | ContentBlockParam[]
  ): AsyncIterable<SDKUserMessage> {
    yield {
      type: 'user',
      message: { role: 'user', content },
      parent_tool_use_id: null,
      session_id: 'bridge',
    } as SDKUserMessage;
  }

  private resolveModel(options?: BackendSendOptions): string | undefined {
    // 仅接受不含 opencode provider 前缀的纯模型 ID 覆盖;
    // 形如 "Provider/xxx/yyy" 的 opencode 风格一律忽略,回落到配置的模型。
    const candidate = options?.modelId?.trim();
    if (candidate && !options?.providerId) {
      return candidate;
    }
    return claudeConfig.model;
  }

  private describeToolInput(tool: string, input?: Record<string, unknown>): string {
    if (!input) return tool;
    if (tool === 'Bash' && typeof input.command === 'string') return `执行命令: ${input.command}`;
    if ((tool === 'Edit' || tool === 'Write') && typeof input.file_path === 'string') {
      return `${tool === 'Write' ? '写入' : '编辑'}文件: ${input.file_path}`;
    }
    const json = JSON.stringify(input);
    return `${tool}: ${json.length > 200 ? json.slice(0, 200) + '…' : json}`;
  }

  private stringifyToolResult(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map((c) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : JSON.stringify(c)))
        .join('\n');
    }
    return content == null ? '' : JSON.stringify(content);
  }

  // 构造一个结构兼容 opencode Session 的对象(下游只读取 id/title/directory/time 等)
  private toOpencodeSession(s: ClaudeSession): Session {
    return {
      id: s.bridgeSessionId,
      projectID: 'claude',
      directory: s.directory,
      title: s.title,
      version: 'claude-agent-sdk',
      time: { created: s.createdAt, updated: s.updatedAt },
    } as Session;
  }
}

export const claudeClient = new ClaudeClientWrapper();
