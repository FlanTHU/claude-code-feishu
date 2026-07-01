/**
 * 解析回复正文里的 bot @ 标记。
 *
 * 背景：飞书互动卡片正文里的 `<at>` 只是渲染标签，不会写进消息事件的 mentions[]，
 * 因此无法触发被 @ 的其他 bot。要触发对方 bot，必须额外发一条 text 消息，
 * 让飞书把 @ 写进 mentions[]。
 *
 * 约定：模型在回复正文里用 `@@mention:ou_xxx@@` 表达"我要 @ 谁"。
 * bridge 在卡片完成时抽出这些标记 → 从卡片正文剥离（卡片保持干净）
 * → 对白名单内的 open_id 补发一条 text @ 消息触发对方。
 */

const MENTION_MARKER_RE = /@@mention:(ou_[A-Za-z0-9]+)@@/g;

export interface ParsedBotMentions {
  /** 剥离 mention 标记后的正文，用于卡片展示 */
  text: string;
  /** 去重后、按出现顺序排列的 open_id 列表 */
  openIds: string[];
}

/**
 * 从正文中抽取 `@@mention:ou_xxx@@` 标记，返回剥离后的正文与 open_id 列表。
 * @param allowed 仅保留此集合内的 open_id（白名单），防止被注入乱 @ 人。
 */
export function parseBotMentions(text: string, allowed: ReadonlySet<string>): ParsedBotMentions {
  const openIds: string[] = [];
  const seen = new Set<string>();

  let match: RegExpExecArray | null;
  MENTION_MARKER_RE.lastIndex = 0;
  while ((match = MENTION_MARKER_RE.exec(text)) !== null) {
    const id = match[1];
    if (allowed.has(id) && !seen.has(id)) {
      seen.add(id);
      openIds.push(id);
    }
  }

  // 无论是否在白名单，所有标记都从正文剥离（避免把内部标记暴露在卡片里）
  const stripped = text.replace(MENTION_MARKER_RE, '').replace(/[ \t]{2,}/g, ' ').trim();

  return { text: stripped, openIds };
}
