/**
 * 控制面板与对话中不展示的 OpenCode 内置 agent 名称（与 OpenCode 侧约定一致）。
 * Feishu / Discord 共用，避免过滤规则漂移。
 */
export const HIDDEN_AGENT_NAMES = new Set(['compaction', 'title', 'summary']);

export function isHiddenAgentName(name: string): boolean {
  return HIDDEN_AGENT_NAMES.has(name);
}

/** 是否应在面板与角色列表中展示 */
export function isAgentVisibleInPanel(agent: { name: string; hidden?: boolean }): boolean {
  return agent.hidden !== true && !isHiddenAgentName(agent.name);
}
