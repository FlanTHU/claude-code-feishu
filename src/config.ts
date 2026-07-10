import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  const normalized = normalizeBooleanToken(value);
  if (!normalized) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parseOptionalBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = normalizeBooleanToken(value);
  if (!normalized) return undefined;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function normalizeBooleanToken(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let normalized = value.trim();
  if (!normalized) return undefined;

  // 兼容行内注释写法：SHOW_X=false # note / SHOW_X=false // note
  normalized = normalized
    .replace(/\s+#.*$/, '')
    .replace(/\s+\/\/.*$/, '')
    .trim();

  if (!normalized) return undefined;

  // 去掉包裹引号
  if (
    (normalized.startsWith('"') && normalized.endsWith('"'))
    || (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized ? normalized.toLowerCase() : undefined;
}

function parseNonNegativeIntEnv(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

// 路由器模式配置
export const routerConfig = {
  // 路由器模式: legacy | dual | router
  // 默认 legacy 确保向后兼容
  mode: (() => {
    const value = process.env.ROUTER_MODE?.trim().toLowerCase();
    if (value === 'legacy' || value === 'dual' || value === 'router') {
      return value as 'legacy' | 'dual' | 'router';
    }
    return 'legacy';
  })(),

  // 启用的平台列表（逗号分隔，如 'feishu,discord'）
  enabledPlatforms: (() => {
    const value = process.env.ENABLED_PLATFORMS;
    if (!value) {
      return [];
    }
    return value
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(item => item.length > 0);
  })(),

  // 检查指定平台是否被明确启用
  isPlatformEnabled(platformId: string): boolean {
    // 如果未指定平台列表，则认为所有平台可用（由各自的启用状态控制）
    if (this.enabledPlatforms.length === 0) {
      return true;
    }
    return this.enabledPlatforms.includes(platformId.toLowerCase());
  },
};

// 飞书配置
export const feishuConfig = {
  appId: process.env.FEISHU_APP_ID || '',
  appSecret: process.env.FEISHU_APP_SECRET || '',
  encryptKey: process.env.FEISHU_ENCRYPT_KEY,
  verificationToken: process.env.FEISHU_VERIFICATION_TOKEN,
  // WebSocket 应用层重连
  wsReconnectDelayMs: parseNonNegativeIntEnv(process.env.FEISHU_WS_RECONNECT_DELAY_MS, 5000),
  wsMaxReconnectAttempts: parseNonNegativeIntEnv(process.env.FEISHU_WS_MAX_RECONNECT_ATTEMPTS, 0), // 0 = 无限
  wsIdleTimeoutMs: parseNonNegativeIntEnv(process.env.FEISHU_WS_IDLE_TIMEOUT_MS, 90000), // 90s 无消息视为断线
};

// Discord配置
export const discordConfig = {
  // 是否启用 Discord 适配器（默认关闭）
  enabled: parseBooleanEnv(process.env.DISCORD_ENABLED, false),

  // Discord Bot Token（兼容 DISCORD_BOT_TOKEN）
  token: process.env.DISCORD_TOKEN?.trim() || process.env.DISCORD_BOT_TOKEN?.trim() || '',

  // Discord Client ID（当前用于配置兼容，后续 OAuth/交互可直接复用）
  clientId: process.env.DISCORD_CLIENT_ID?.trim() || '',

  // 允许其他 Bot 添加到白名单（逗号分隔的 Discord snowflake ID 列表）
  // 仅接受纯数字格式的 ID，无效 ID 会被跳过
  allowedBotIds: (() => {
    const raw = process.env.DISCORD_ALLOWED_BOT_IDS || '';
    return raw
      .split(',')
      .map(item => item.trim())
      .filter(item => {
        if (!item) return false;
        // Discord snowflake 是纯数字
        if (!/^\d+$/.test(item)) {
          console.warn(`[Config] 无效的 Bot ID "${item}" 已被跳过（需为纯数字）`);
          return false;
        }
        return true;
      });
  })(),
  };

// 群聊消息触发策略
export const groupConfig = {
  // 为 true 时：群聊仅在消息明确 @ 时才触发机器人处理
  // 兼容别名 GROUP_REPLY_REQUIRE_MENTION
  requireMentionInGroup: parseBooleanEnv(
    process.env.GROUP_REQUIRE_MENTION ?? process.env.GROUP_REPLY_REQUIRE_MENTION,
    false
  ),
  // Bot 自身的 open_id，用于群聊 @ 过滤（只响应 @自己 的消息）
  // 若未配置则退回旧逻辑（有任意 mention 即触发）
  botOpenId: process.env.BOT_OPEN_ID?.trim() || '',
  // 文本关键词触发列表，消息包含任一关键词时等效于 @bot（逗号分隔）
  // 用于其他 bot 无法直接 @ 时的文本触发方案
  triggerKeywords: (process.env.BOT_TRIGGER_KEYWORDS ?? '')
    .split(',')
    .map(k => k.trim())
    .filter(k => k.length > 0),
  // 允许接收消息的 bot open_id 白名单（逗号分隔）。
  // 默认 bot 消息全部丢弃以防机器人互刷；列入此名单的 bot 消息放行，
  // 后续仍受 requireMentionInGroup（需 @ 才触发）约束。
  allowedBotOpenIds: new Set(
    (process.env.ALLOWED_BOT_OPEN_IDS ?? '')
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0)
  ),
  // bot↔bot 连续接力的最大往返轮数。白名单 bot 每触发一次 +1，owner 真人发言清零；
  // 达到上限后暂停自动接力，需 owner 介入确认。防止两个 bot 互相触发无限回环。
  botRelayMaxRounds: (() => {
    const n = parseInt(process.env.BOT_RELAY_MAX_ROUNDS ?? '10', 10);
    return Number.isFinite(n) && n > 0 ? n : 10;
  })(),
  // bot↔bot 接力计数的冷却时长（毫秒）。距上次接力超过此时长视为新对话，
  // 计数自动归零。默认 30 分钟，避免跨越长时间的对话被误算成连续接力。
  botRelayCooldownMs: (() => {
    const n = parseInt(process.env.BOT_RELAY_COOLDOWN_MS ?? '', 10);
    return Number.isFinite(n) && n > 0 ? n : 30 * 60 * 1000;
  })(),
};

// OpenCode配置
export const opencodeConfig = {
  host: process.env.OPENCODE_HOST || 'localhost',
  port: parseInt(process.env.OPENCODE_PORT || '4096', 10),
  serverUsername: process.env.OPENCODE_SERVER_USERNAME?.trim() || 'opencode',
  serverPassword: process.env.OPENCODE_SERVER_PASSWORD?.trim() || undefined,
  get baseUrl() {
    return `http://${this.host}:${this.port}`;
  },
  // 事件流心跳超时（ms），超时则主动断开重连
  eventHeartbeatTimeoutMs: parseNonNegativeIntEnv(process.env.OPENCODE_EVENT_HEARTBEAT_TIMEOUT_MS, 60000),
  eventMaxBackoffMs: parseNonNegativeIntEnv(process.env.OPENCODE_EVENT_MAX_BACKOFF_MS, 30000),
};

// 单例锁配置:用独占绑定该端口实现进程互斥,防止多实例同连飞书导致重复回复。
// 独立于 opencode(4096)与 local-api(4097)端口。详见 src/utils/singleton-lock.ts
export const singletonConfig = {
  port: parseInt(process.env.BRIDGE_SINGLETON_PORT || '4099', 10),
};

// AI 后端选择:opencode(默认) | claude
// 同一时间只跑一个后端;切换需重启服务。详见 docs/claude-code-backend-research.md
const configuredBackend = (process.env.AI_BACKEND || 'opencode').trim().toLowerCase();
export const backendConfig = {
  backend: (configuredBackend === 'claude' ? 'claude' : 'opencode') as 'opencode' | 'claude',
};

// Claude Code(Agent SDK)后端配置 —— 仅 AI_BACKEND=claude 时生效
export const claudeConfig = {
  // 鉴权沿用 Agent SDK 认的环境变量:ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
  // 这里只配模型与运行参数
  model: process.env.CLAUDE_MODEL?.trim() || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() || undefined,
  models: [
    process.env.CLAUDE_MODEL?.trim() || process.env.ANTHROPIC_DEFAULT_OPUS_MODEL?.trim() || undefined,
    ...(process.env.CLAUDE_MODELS || '')
      .split(',')
      .map(item => item.trim())
      .filter(item => item.length > 0),
  ].filter((item, index, items): item is string => Boolean(item) && items.indexOf(item) === index),
  // 工作目录:Claude Code 在此目录读写文件
  cwd: process.env.CLAUDE_CWD?.trim() || process.cwd(),
  // 权限模式:default(走 PreToolUse hook 交互) | acceptEdits | bypassPermissions | plan
  permissionMode: (process.env.CLAUDE_PERMISSION_MODE?.trim() || 'default') as
    | 'default'
    | 'acceptEdits'
    | 'bypassPermissions'
    | 'plan',
  // 权限请求在飞书侧等待用户操作的超时(ms),超时按拒绝处理
  permissionTimeoutMs: parseNonNegativeIntEnv(process.env.CLAUDE_PERMISSION_TIMEOUT_MS, 5 * 60 * 1000),
  // 人格/交互约束系统提示文件路径(markdown),内容以 append 形式叠加到
  // Claude Code preset 之上(保留默认工具能力)。默认指向项目内 persona 文件。
  systemPromptFile:
    process.env.CLAUDE_SYSTEM_PROMPT_FILE?.trim() ||
    path.join(process.cwd(), 'persona', 'system-prompt.md'),
  // hmem 跨会话长期记忆(复用 opencode 的 hmem-mcp-fork,标准 stdio MCP)。
  // 接入开关:默认开;CLAUDE_ENABLE_HMEM=false 可一键关闭。
  // 鉴权 key 从环境变量或 macOS keychain 读,不硬编码;取不到则不接入(软降级)。
  hmem: {
    enabled: parseBooleanEnv(process.env.CLAUDE_ENABLE_HMEM, true),
    // 启动 hmem 的 node 可执行文件,默认用运行 bridge 的同一 node
    nodeBin: process.env.HMEM_NODE_BIN?.trim() || process.execPath,
    // hmem-mcp-fork 的 CLI 入口
    cli:
      process.env.HMEM_MCP_CLI?.trim() ||
      path.join(process.env.HOME || '~', '.config/opencode/hmem-mcp-fork/dist/cli.js'),
    // 记忆库目录(SQLite 所在)
    projectDir:
      process.env.HMEM_PROJECT_DIR?.trim() ||
      path.join(process.env.HOME || '~', '.hmem'),
    // embedding 走 mify,禁用本地 ollama(与 opencode 配置一致)
    ollamaDisabled: parseBooleanEnv(process.env.HMEM_OLLAMA_DISABLED, true),
  },
};

// 解析 hmem 算 embedding 所需的 MIFY_API_KEY:优先环境变量,
// 回落到 macOS keychain(account=opencode, service=MIFY_API_KEY,与
// opencode 的 dream-distill 同源)。两者都取不到返回空串。
export function resolveMifyApiKey(): string {
  const fromEnv = process.env.MIFY_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const fromKeychain = execFileSync(
      'security',
      ['find-generic-password', '-a', 'opencode', '-s', 'MIFY_API_KEY', '-w'],
      { encoding: 'utf-8' }
    ).trim();
    return fromKeychain || '';
  } catch {
    return '';
  }
}

// 读取人格系统提示文件内容;文件不存在则返回空(不注入)。
export function loadClaudeSystemPrompt(): string | undefined {
  try {
    const content = fs.readFileSync(claudeConfig.systemPromptFile, 'utf-8').trim();
    return content || undefined;
  } catch {
    return undefined;
  }
}

// 用户配置
export const userConfig = {
  // 允许使用机器人的用户open_id列表
  allowedUsers: (process.env.ALLOWED_USERS || '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0),

  // 是否开启手动绑定已有 OpenCode 会话能力
  enableManualSessionBind: parseBooleanEnv(process.env.ENABLE_MANUAL_SESSION_BIND, true),
  
  // 是否启用用户白名单（如果为空则不限制）
  get isWhitelistEnabled() {
    return this.allowedUsers.length > 0;
  },
};

// Owner 配置（群聊安全防注入）
export const ownerConfig = {
  // 拥有完整指令权限的 owner open_id 列表（逗号分隔）
  // 群聊中非 owner 的消息仅允许普通问答，执行操作需 owner 确认
  ownerIds: (process.env.OWNER_USER_IDS || '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0),

  // 是否启用 owner 鉴权（ownerIds 非空时自动启用）
  get isEnabled() {
    return this.ownerIds.length > 0;
  },

  // 判断指定用户是否为 owner
  isOwner(openId: string): boolean {
    if (!this.isEnabled) return true; // 未配置则视所有人为 owner
    return this.ownerIds.includes(openId);
  },
};

// 模型配置
const configuredDefaultProvider = process.env.DEFAULT_PROVIDER?.trim();
const configuredDefaultModel = process.env.DEFAULT_MODEL?.trim();
const hasConfiguredDefaultModel = Boolean(configuredDefaultProvider && configuredDefaultModel);

export const modelConfig = {
  // 不配置时交由 OpenCode 自身默认模型决策
  defaultProvider: hasConfiguredDefaultModel ? configuredDefaultProvider : undefined,
  defaultModel: hasConfiguredDefaultModel ? configuredDefaultModel : undefined,
};

function loadModelCapabilities(): Map<string, boolean> {
  const caps = new Map<string, boolean>();
  const candidates = [
    process.env.OPENCODE_CONFIG_PATH,
    path.join(process.env.HOME || '~', '.config/opencode/opencode.json'),
    path.join(process.cwd(), 'opencode.json'),
  ].filter(Boolean) as string[];

  for (const configPath of candidates) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const providers = raw.provider || {};
      for (const [provName, prov] of Object.entries(providers)) {
        const models = (prov as Record<string, unknown>).models as Record<string, Record<string, unknown>> | undefined;
        if (!models) continue;
        for (const [modelId, modelCfg] of Object.entries(models)) {
          const cfg = modelCfg as Record<string, unknown>;
          const modalities = cfg.modalities as Record<string, unknown> | undefined;
          const supports = cfg.attachment === true
            || (Array.isArray(modalities?.input) && (modalities.input as string[]).includes('image'));
          caps.set(`${provName}/${modelId}`, supports);
        }
      }
      break;
    } catch { /* ignore parse errors */ }
  }
  return caps;
}

const modelCapabilityCache = loadModelCapabilities();

export function modelSupportsImages(providerModel: string): boolean {
  return modelCapabilityCache.get(providerModel) ?? false;
}

// 权限配置
export const permissionConfig = {
  // 自动允许的工具列表
  toolWhitelist: (process.env.TOOL_WHITELIST || 'Read,Glob,Grep,Task').split(',').filter(Boolean),

  // 权限请求超时时间（毫秒）；<= 0 表示不超时，始终等待用户回复。
  // Claude 后端下若未显式配置，自动对齐到 claude 侧硬超时 + 30s 宽限：
  // claude 侧 timer 先触发并 resolve(deny)，宽限期内用户回复走 Fix B 清僵尸；
  // 超过宽限则 handler 侧 removeExpired 兜底清除，避免永久僵尸挡住后续普通消息。
  requestTimeout: parseNonNegativeIntEnv(
    process.env.PERMISSION_REQUEST_TIMEOUT_MS,
    backendConfig.backend === 'claude' ? claudeConfig.permissionTimeoutMs + 30_000 : 0
  ),
};

// 输出配置
const showThinkingChain = parseBooleanEnv(process.env.SHOW_THINKING_CHAIN, true);
const showToolChain = parseBooleanEnv(process.env.SHOW_TOOL_CHAIN, true);

export const outputConfig = {
  // 输出更新间隔（毫秒）
  updateInterval: parseInt(process.env.OUTPUT_UPDATE_INTERVAL || '3000', 10),

  // 消息发出后无任何输出的超时时间（毫秒）；0 表示禁用
  silenceTimeoutMs: parseNonNegativeIntEnv(process.env.SILENCE_TIMEOUT_MS, 30000),

  // 单条消息最大长度（飞书限制）
  maxMessageLength: 4000,
  
  // 思维链可见性控制（默认为 true，保持向后兼容）
  showThinkingChain,
  
  // 工具链可见性控制（默认为 true，保持向后兼容）
  showToolChain,
  
  // 飞书平台特定可见性控制
  feishu: {
    showThinkingChain: parseOptionalBooleanEnv(process.env.FEISHU_SHOW_THINKING_CHAIN) ?? showThinkingChain,
    showToolChain: parseOptionalBooleanEnv(process.env.FEISHU_SHOW_TOOL_CHAIN) ?? showToolChain,
    // 完成卡片底部的人格签名（菈妮落款），默认开启
    personaSignature: parseBooleanEnv(process.env.FEISHU_PERSONA_SIGNATURE, true),
  },
  
  // Discord 平台特定可见性控制
  discord: {
    showThinkingChain: parseOptionalBooleanEnv(process.env.DISCORD_SHOW_THINKING_CHAIN) ?? showThinkingChain,
    showToolChain: parseOptionalBooleanEnv(process.env.DISCORD_SHOW_TOOL_CHAIN) ?? showToolChain,
  },
};
// 附件配置
export const attachmentConfig = {
  maxSize: parseInt(process.env.ATTACHMENT_MAX_SIZE || String(50 * 1024 * 1024), 10),
};

function parseProjectAliases(value: string | undefined): Record<string, string> {
  if (!value) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const result = Object.create(null) as Record<string, string>;
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof item === 'string' && item.trim()) {
        // 过滤原型污染 key
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          continue;
        }
        result[key] = item.trim();
      }
    }
    return result;
  } catch (error) {
    console.warn('[Config] PROJECT_ALIASES 解析失败:', error);
    return {};
  }
}

// 目录配置
export const directoryConfig = {
  allowedDirectories: (process.env.ALLOWED_DIRECTORIES || '')
    .split(',')
    .map(item => item.trim())
    .filter(item => item.length > 0),
  defaultWorkDirectory: process.env.DEFAULT_WORK_DIRECTORY?.trim() || undefined,
  projectAliases: parseProjectAliases(process.env.PROJECT_ALIASES),
  gitRootNormalization: parseBooleanEnv(process.env.GIT_ROOT_NORMALIZATION, true),
  maxPathLength: 500,
  get isAllowlistEnforced() {
    return this.allowedDirectories.length > 0;
  },
};

// 验证配置
export function validateConfig(): void {
  const errors: string[] = [];
  
  if (!feishuConfig.appId) {
    errors.push('缺少 FEISHU_APP_ID');
  }
  if (!feishuConfig.appSecret) {
    errors.push('缺少 FEISHU_APP_SECRET');
  }
  
  if (errors.length > 0) {
    throw new Error(`配置错误:\n${errors.join('\n')}`);
  }
}
