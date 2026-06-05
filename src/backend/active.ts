// 当前激活的 AI 后端单例。
// 根据 AI_BACKEND 环境变量在启动时一次性选定;同一时间只跑一个后端。
// 详见 docs/claude-code-backend-research.md

import { backendConfig } from '../config.js';
import { opencodeClient } from '../opencode/client.js';
import { claudeClient } from '../claude/client.js';
import type { AiBackend } from './types.js';

export const activeBackend: AiBackend =
  backendConfig.backend === 'claude' ? claudeClient : opencodeClient;

export const activeBackendId = backendConfig.backend;
