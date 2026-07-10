import { outputConfig } from '../config.js';

export * from './cards.js';

export type StreamToolState = {
  name: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  output?: string;
};

export type StreamCardSegment =
  | {
      type: 'reasoning';
      text: string;
    }
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'tool';
      name: string;
      status: 'pending' | 'running' | 'completed' | 'failed';
      output?: string;
      kind?: 'tool' | 'subtask';
    }
  | {
      type: 'note';
      text: string;
      variant?: 'retry' | 'compaction' | 'question' | 'error' | 'permission';
    };

export interface StreamCardPendingPermission {
  sessionId: string;
  permissionId: string;
  tool: string;
  description: string;
  risk?: string;
  pendingCount?: number;
}

export interface StreamCardQuestionOption {
  label: string;
  description?: string;
}

export interface StreamCardPendingQuestion {
  requestId: string;
  sessionId: string;
  chatId: string;
  questionIndex: number;
  totalQuestions: number;
  header: string;
  question: string;
  options: StreamCardQuestionOption[];
  multiple?: boolean;
}

export interface StreamCardData {
  thinking: string;
  showThinking?: boolean;
  text: string;
  chatId?: string;
  chatType?: 'p2p' | 'group';
  messageId?: string;
  thinkingMessageId?: string;
  tools: StreamToolState[];
  segments?: StreamCardSegment[];
  pendingPermission?: StreamCardPendingPermission;
  pendingQuestion?: StreamCardPendingQuestion;
  status: 'processing' | 'completed' | 'failed';
  elapsedSecs?: number;
  /** 当前使用的模型，展示在卡片 header */
  currentModel?: string;
}

/** 有序列表项模式：以数字+点开头，避免误判为多轮对话 */
const ORDERED_LIST_ITEM_RE = /^\d+[.)]\s/;

function formatMultiTurnAnswer(answer: string): string {
  const cleaned = answer.replace(/[ \t]*<!--ctx:[^>]*-->/g, '').replace(/\n{3,}/g, '\n\n').trim();
  const paras = cleaned.split(/\n{2,}/).map((p: string) => p.trim()).filter(Boolean);
  if (paras.length < 2) return cleaned;

  const SHORT_MAX_CHARS = 80;
  const SHORT_MAX_LINES = 3;
  const isShort = (p: string) => {
    const lines = p.split('\n');
    return lines.length <= SHORT_MAX_LINES && p.length <= SHORT_MAX_CHARS;
  };

  /** 有序列表项不参与多轮对话转换，保持原样 */
  const isOrderedListItem = (p: string) => ORDERED_LIST_ITEM_RE.test(p);

  let turnCount = 0;
  for (let i = 0; i < paras.length - 1; i++) {
    if (!isOrderedListItem(paras[i]) && isShort(paras[i]) && !isShort(paras[i + 1])) turnCount++;
  }
  if (turnCount === 0) return cleaned;

  const out: string[] = [];
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    const next = paras[i + 1];
    if (!isOrderedListItem(p) && isShort(p) && next && !isShort(next)) {
      if (out.length > 0) out.push('---');
      const lines = p.split('\n');
      lines[0] = `💬 ${lines[0]}`;
      out.push(lines.map((l: string) => `> ${l}`).join('\n'));
    } else {
      out.push(p);
    }
  }
  return out.join('\n\n');
}

function splitTextByBytes(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (Buffer.byteLength(remaining, 'utf8') <= maxBytes) {
      chunks.push(remaining);
      break;
    }

    // Binary-search for the largest char-index whose UTF-8 byte length fits maxBytes
    let lo = 0;
    let hi = remaining.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (Buffer.byteLength(remaining.slice(0, mid), 'utf8') <= maxBytes) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    let splitIdx = lo;

    // Try to split at paragraph boundary within the safe window
    const windowStart = Math.floor(splitIdx * 0.3);
    const dblNl = remaining.lastIndexOf('\n\n', splitIdx);
    if (dblNl > windowStart) {
      splitIdx = dblNl;
    } else {
      const singleNl = remaining.lastIndexOf('\n', splitIdx);
      if (singleNl > windowStart) splitIdx = singleNl;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, '');
  }

  return chunks;
}

function escapeCodeBlockContent(text: string): string {
  return text.replace(/```/g, '` ` `');
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}...`;
}

function truncateMiddleText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  const marker = `\n...（中间省略 ${text.length - limit} 字）...\n`;
  const available = Math.max(limit - marker.length, 200);
  const headLength = Math.max(Math.floor(available * 0.55), 120);
  const tailLength = Math.max(available - headLength, 80);
  return `${text.slice(0, headLength)}${marker}${text.slice(-tailLength)}`;
}

function getToolStatusLabel(status: StreamToolState['status']): { icon: string; text: string } {
  if (status === 'running') {
    return { icon: '⏳', text: '执行中' };
  }
  if (status === 'completed') {
    return { icon: '✅', text: '已完成' };
  }
  if (status === 'failed') {
    return { icon: '❌', text: '失败' };
  }
  return { icon: '⏸️', text: '等待中' };
}

function getRiskLabel(risk?: string): string {
  if (risk === 'high') return '⚠️ 高风险';
  if (risk === 'medium') return '⚡ 中风险';
  return '✅ 低风险';
}

export interface StreamCardBuildOptions {
  componentBudget?: number;
}

const DEFAULT_STREAM_CARD_COMPONENT_BUDGET = 175;
const MIN_STREAM_CARD_COMPONENT_BUDGET = 10;
const MAX_TIMELINE_SEGMENTS = 30;
const MAX_CARD_BODY_BYTES = 28 * 1024;
const MAX_REASONING_SEGMENT_LENGTH = 2600;
const MAX_TOOL_OUTPUT_LENGTH = 4000;
const MAX_TEXT_SEGMENT_LENGTH = 30000;
const MAX_THINKING_PANEL_LENGTH = 2600;
const MAX_BODY_TEXT_LENGTH = 30000;

function isHrElement(element: object): boolean {
  const value = element as { tag?: unknown };
  return value.tag === 'hr';
}

function countComponentTags(node: unknown): number {
  if (Array.isArray(node)) {
    let total = 0;
    for (const item of node) {
      total += countComponentTags(item);
    }
    return total;
  }

  if (!node || typeof node !== 'object') {
    return 0;
  }

  const record = node as Record<string, unknown>;
  let count = 'tag' in record ? 1 : 0;

  for (const key of ['elements', 'columns', 'content', 'body']) {
    if (key in record) {
      count += countComponentTags(record[key]);
    }
  }

  if ('header' in record && record.header && typeof record.header === 'object') {
    const header = record.header as Record<string, unknown>;
    for (const key of ['title', 'subtitle']) {
      if (key in header && header[key] && typeof header[key] === 'object') {
        const child = header[key] as Record<string, unknown>;
        if ('tag' in child) count += 1;
      }
    }
  }

  return count;
}

function normalizeElementPage(elements: object[]): object[] {
  const normalized: object[] = [];
  for (const element of elements) {
    if (isHrElement(element)) {
      if (normalized.length === 0) {
        continue;
      }
      const last = normalized[normalized.length - 1];
      if (isHrElement(last)) {
        continue;
      }
    }
    normalized.push(element);
  }

  while (normalized.length > 0 && isHrElement(normalized[normalized.length - 1])) {
    normalized.pop();
  }

  return normalized;
}

function paginateElementsByComponentBudget(elements: object[], componentBudget: number): object[][] {
  const safeBudget = Math.max(componentBudget, MIN_STREAM_CARD_COMPONENT_BUDGET);
  const budgetForBody = Math.max(1, safeBudget - 1);
  const pages: object[][] = [];
  let currentPage: object[] = [];
  let currentCount = 0;
  let currentBytes = 0;

  for (const element of elements) {
    const componentCount = Math.max(1, countComponentTags(element));
    const elementBytes = Buffer.byteLength(JSON.stringify(element), 'utf8');

    if (currentPage.length > 0 && (
      currentCount + componentCount > budgetForBody ||
      currentBytes + elementBytes > MAX_CARD_BODY_BYTES
    )) {
      const normalized = normalizeElementPage(currentPage);
      if (normalized.length > 0) {
        pages.push(normalized);
      }
      currentPage = [];
      currentCount = 0;
      currentBytes = 0;
    }

    currentPage.push(element);
    currentCount += componentCount;
    currentBytes += elementBytes;
  }

  const normalized = normalizeElementPage(currentPage);
  if (normalized.length > 0) {
    pages.push(normalized);
  }

  if (pages.length === 0) {
    pages.push([{ tag: 'markdown', content: '（无输出）' }]);
  }

  return pages;
}

/** 判断两段文本是否实质重复（用于去重恶性重复） */
function isSegmentDuplicate(prev: string, curr: string): boolean {
  if (!prev || !curr) return false;
  const p = prev.trim();
  const c = curr.trim();
  if (p === c) return true;
  const minLen = Math.min(p.length, c.length);
  const maxLen = Math.max(p.length, c.length);
  if (minLen < 40 || maxLen < 60) return false;
  const shorter = p.length <= c.length ? p : c;
  const longer = p.length > c.length ? p : c;
  // 一方是另一方的子串且重叠超过 75% 视为重复
  return longer.includes(shorter) && minLen / maxLen >= 0.75;
}

/** 生成内容指纹，用于跨段去重（长文本取首尾+长度，短文本用全文） */
function contentFingerprint(text: string, maxLen = 300): string {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  return `${t.slice(0, 150)}|${t.length}|${t.slice(-100)}`;
}

/** 段内段落去重：防止模型恶性循环时同一段落在单 segment 内反复刷屏 */
function deduplicateRepeatedParagraphs(text: string): string {
  const paras = text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  if (paras.length < 2) return text;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paras) {
    const fp = contentFingerprint(p);
    if (seen.has(fp)) continue;
    out.push(p);
    seen.add(fp);
  }
  return out.join('\n\n');
}

function buildTimelineElements(
  segments: StreamCardSegment[],
  options?: { showThinking?: boolean; showTools?: boolean }
): object[] {
  const elements: object[] = [];
  const textAndReasoningSegments = segments.filter(s => s.type === 'text' || s.type === 'reasoning');
  const otherSegments = segments.filter(s => s.type !== 'text' && s.type !== 'reasoning');
  const trimmedOthers = otherSegments.slice(-(MAX_TIMELINE_SEGMENTS - textAndReasoningSegments.length));
  const visibleSegments = [...textAndReasoningSegments, ...trimmedOthers].sort(
    (a, b) => segments.indexOf(a) - segments.indexOf(b)
  );

  let lastReasoningText = '';
  let lastTextContent = '';
  const seenFingerprints = new Set<string>();

  for (const segment of visibleSegments) {
    let nextElement: object | null = null;

    if (segment.type === 'reasoning') {
      if (options?.showThinking === false) {
        continue;
      }
      const rawText = segment.text.trim();
      if (!rawText) {
        continue;
      }
      // 段内段落去重：防止单 segment 内恶性循环刷屏
      const text = deduplicateRepeatedParagraphs(rawText);
      if (!text) {
        continue;
      }
      // 去重：跳过与上一段 reasoning 实质重复的内容
      if (isSegmentDuplicate(lastReasoningText, text)) {
        continue;
      }
      // 跨段去重：若指纹已出现过则跳过（恶性循环时同一内容会反复出现）
      const fp = contentFingerprint(text);
      if (seenFingerprints.has(fp)) {
        continue;
      }
      seenFingerprints.add(fp);
      lastReasoningText = text;

      const rendered = truncateMiddleText(text, MAX_REASONING_SEGMENT_LENGTH);
      nextElement = {
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: {
            tag: 'plain_text',
            content: `🤔 思考过程 (${rendered.length}字)`,
          },
        },
        elements: [
          {
            tag: 'markdown',
            content: `\`\`\`\n${escapeCodeBlockContent(rendered)}\n\`\`\``,
          },
        ],
      };
    } else if (segment.type === 'tool') {
      if (options?.showTools === false) {
        continue;
      }
      const statusInfo = getToolStatusLabel(segment.status);
      const toolKindLabel = segment.kind === 'subtask' ? '子任务' : '工具';
      const output = segment.output?.trim() ? truncateMiddleText(segment.output.trim(), MAX_TOOL_OUTPUT_LENGTH) : '';
      const panelElements: object[] = [
        {
          tag: 'markdown',
          content: `状态：**${statusInfo.text}**`,
        },
      ];

      if (output) {
        panelElements.push({
          tag: 'markdown',
          content: `\`\`\`\n${escapeCodeBlockContent(output)}\n\`\`\``,
        });
      } else if (segment.status === 'running' || segment.status === 'pending') {
        panelElements.push({
          tag: 'markdown',
          content: '等待工具输出...',
        });
      }

      nextElement = {
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: {
            tag: 'plain_text',
            content: `${statusInfo.icon} ${toolKindLabel} · ${segment.name}`,
          },
        },
        elements: panelElements,
      };
    } else if (segment.type === 'text') {
      if (!segment.text.trim()) {
        continue;
      }
      // 段内段落去重：防止单 segment 内恶性循环刷屏
      const text = deduplicateRepeatedParagraphs(segment.text.trim());
      if (!text) {
        continue;
      }
      // 去重：跳过与上一段 text 实质重复的内容
      if (isSegmentDuplicate(lastTextContent, text)) {
        continue;
      }
      // 跨段去重：若指纹已出现过则跳过
      const fp = contentFingerprint(text);
      if (seenFingerprints.has(fp)) {
        continue;
      }
      seenFingerprints.add(fp);
      lastTextContent = text;

      const formattedSegText = formatMultiTurnAnswer(text);
      const MARKDOWN_BYTE_LIMIT = 26 * 1024;
      const segChunks = splitTextByBytes(formattedSegText, MARKDOWN_BYTE_LIMIT);
      if (segChunks.length === 0) continue;
      nextElement = { tag: 'markdown', content: segChunks[0] };
      if (segChunks.length > 1) {
        if (elements.length > 0) elements.push({ tag: 'hr' });
        elements.push(nextElement);
        for (let ci = 1; ci < segChunks.length; ci++) {
          elements.push({ tag: 'hr' });
          elements.push({ tag: 'markdown', content: segChunks[ci] });
        }
        nextElement = null;
      }
    } else if (segment.type === 'note') {
      const text = segment.text.trim();
      if (!text) {
        continue;
      }
      nextElement = {
        tag: 'markdown',
        content: truncateText(text, 800),
      };
    }

    if (!nextElement) {
      continue;
    }

    if (elements.length > 0) {
      elements.push({ tag: 'hr' });
    }
    elements.push(nextElement);
  }

  return elements;
}

function buildPendingPermissionElements(permission: StreamCardPendingPermission): object[] {
  const blocks: object[] = [];
  const toolName = permission.tool.trim() || 'unknown';
  const description = truncateMiddleText(permission.description.trim() || '（无描述）', 1600);
  const pendingCountText = permission.pendingCount && permission.pendingCount > 1
    ? `\n> 当前待确认权限：${permission.pendingCount} 项（仅展示最早一项）`
    : '';

  blocks.push({ tag: 'hr' });
  blocks.push({
    tag: 'collapsible_panel',
    expanded: true,
    header: {
      title: {
        tag: 'plain_text',
        content: `🔐 权限确认 · ${toolName}`,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: `风险等级：**${getRiskLabel(permission.risk)}**${pendingCountText}`,
      },
      {
        tag: 'markdown',
        content: `\`\`\`\n${escapeCodeBlockContent(description)}\n\`\`\``,
      },
      {
        tag: 'markdown',
        content: '请在群里回复：`允许` / `拒绝` / `始终允许`（也支持 `y` / `n` / `always`）',
      },
    ],
  });

  return blocks;
}

function buildPendingQuestionElements(question: StreamCardPendingQuestion): object[] {
  const blocks: object[] = [];
  const labels = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const options = question.options.slice(0, 20);
  const optionLines = options.map((item, index) => {
    const number = index + 1;
    const prefix = index < labels.length ? `${labels[index]}(${number}).` : `${number}.`;
    const description = item.description?.trim() ? `: ${truncateText(item.description.trim(), 100)}` : '';
    return `${prefix} **${item.label}**${description}`;
  });
  if (question.options.length > options.length) {
    optionLines.push(`... 其余 ${question.options.length - options.length} 个选项已省略显示`);
  }

  const title = `**问题 ${question.questionIndex + 1}/${question.totalQuestions}**`;
  const headerLine = question.header.trim();
  const questionLine = question.question.trim();
  const bodyLines = [title, headerLine, questionLine, optionLines.join('\n')].filter(line => line && line.trim()).join('\n\n');
  const hint = question.multiple
    ? '请直接回复：可多选（例如 A,C 或 1 3），不匹配选项会按自定义答案处理。'
    : '请直接回复：单选可用 A 或 1，不匹配选项会按自定义答案处理。';

  blocks.push({ tag: 'hr' });
  blocks.push({
    tag: 'collapsible_panel',
    expanded: true,
    header: {
      title: {
        tag: 'plain_text',
        content: '🤝 问答交互',
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: truncateMiddleText(bodyLines, 2600),
      },
      {
        tag: 'markdown',
        content: hint,
      },
      {
        tag: 'markdown',
        content: '输入"跳过"可跳过本题。',
      },
    ],
  });

  return blocks;
}

function buildStreamCardElements(
  data: StreamCardData,
  options?: { showThinking?: boolean; showTools?: boolean }
): object[] {
  const elements: object[] = [];

  if (data.currentModel && data.status !== 'completed') {
    elements.push({
      tag: 'markdown',
      content: `**模型:** ${data.currentModel}`,
    });
  }

  const thinkingText = data.thinking.trim();

  // 群聊强制隐藏 thinking/tools，不依赖 session 推断，确保生效
  const forceHideForGroup = data.chatType === 'group';
  const effectiveShowThinking = forceHideForGroup ? false : (options?.showThinking ?? true);
  const effectiveShowTools = forceHideForGroup ? false : (options?.showTools ?? true);

  const timelineElements = Array.isArray(data.segments) && data.segments.length > 0
    ? buildTimelineElements(data.segments, { showThinking: effectiveShowThinking, showTools: effectiveShowTools })
    : [];

  if (timelineElements.length > 0) {
    elements.push(...timelineElements);
  }

  const showThinking = effectiveShowThinking;
  const showTools = effectiveShowTools;

  if (timelineElements.length === 0) {
    // 1. 思考过程（原生折叠面板）
    if (thinkingText && showThinking) {
      const dedupedThinking = deduplicateRepeatedParagraphs(thinkingText);
      const renderedThinking = truncateMiddleText(dedupedThinking, MAX_THINKING_PANEL_LENGTH);
      elements.push({
        tag: 'collapsible_panel',
        expanded: false,
        header: {
          title: {
            tag: 'plain_text',
            content: `🤔 思考过程 (${renderedThinking.length}字)`,
          },
        },
        elements: [
          {
            tag: 'markdown',
            content: `\`\`\`\n${escapeCodeBlockContent(renderedThinking)}\n\`\`\``,
          },
        ],
      });
    }

    // 2. 工具调用列表
    if (data.tools.length > 0 && showTools) {
      if (elements.length > 0) {
        elements.push({ tag: 'hr' });
      }

      const toolLines = data.tools.map(tool => {
        const icon = tool.status === 'running' ? '⏳' : tool.status === 'completed' ? '✅' : tool.status === 'failed' ? '❌' : '⏸️';
        let line = `${icon} **${tool.name}**`;
        if (tool.output) {
          const output = tool.output.length > 200 ? tool.output.slice(0, 200) + '...' : tool.output;
          line += `\n> ${output.replace(/\n/g, '\n> ')}`;
        }
        return line;
      });

      elements.push({
        tag: 'markdown',
        content: toolLines.join('\n\n'),
      });
    }

    // 3. 正文
    if (data.text) {
      if (elements.length > 0) {
        elements.push({ tag: 'hr' });
      }
      const dedupedText = deduplicateRepeatedParagraphs(data.text);
      const formattedText = formatMultiTurnAnswer(dedupedText);
      const MARKDOWN_BYTE_LIMIT = 26 * 1024;
      const textChunks = splitTextByBytes(formattedText, MARKDOWN_BYTE_LIMIT);
      for (let ci = 0; ci < textChunks.length; ci++) {
        if (ci > 0) elements.push({ tag: 'hr' });
        elements.push({ tag: 'markdown', content: textChunks[ci] });
      }
    } else if (data.status === 'processing') {
      if (elements.length > 0) {
        elements.push({ tag: 'hr' });
      }
      elements.push({
        tag: 'markdown',
        content: '▋',
      });
    } else if (elements.length === 0) {
      elements.push({
        tag: 'markdown',
        content: '（无输出）',
      });
    }
  } else if (data.status === 'processing') {
    if (elements.length > 0) {
      elements.push({ tag: 'hr' });
    }
    elements.push({
      tag: 'markdown',
      content: '▋',
    });
  }

  if (elements.length === 0) {
    elements.push({
      tag: 'markdown',
      content: '（无输出）',
    });
  }

  if (data.pendingPermission) {
    elements.push(...buildPendingPermissionElements(data.pendingPermission));
  }

  if (data.pendingQuestion) {
    elements.push(...buildPendingQuestionElements(data.pendingQuestion));
  }

  return elements;
}

function buildStreamCardPayload(
  elements: object[],
  statusText: string,
  statusColor: 'blue' | 'green' | 'red',
  data?: StreamCardData
): object {
  const normalizedElements = elements.length > 0
    ? elements
    : [{ tag: 'markdown', content: '（无输出）' }];

  const subtitleParts: string[] = [];
  if (data?.currentModel) {
    subtitleParts.push(`🤖 ${data.currentModel}`);
  }
  if (data?.elapsedSecs) {
    subtitleParts.push(`⏱️ ${formatElapsed(data.elapsedSecs)}`);
  }
  if (data?.tools && data.tools.length > 0) {
    const completedTools = data.tools.filter(t => t.status === 'completed').length;
    subtitleParts.push(`🔧 ${completedTools}/${data.tools.length} 工具`);
  }
  const headerSubtitle = subtitleParts.length > 0
    ? { tag: 'plain_text', content: subtitleParts.join('  ·  ') }
    : undefined;

  const bodyElements: object[] = [...normalizedElements];

  const isFinished = data?.status === 'completed' || data?.status === 'failed';
  if (isFinished && outputConfig.feishu.personaSignature) {
    bodyElements.push({ tag: 'hr' });
    bodyElements.push({
      tag: 'markdown',
      content: `<font color="grey">🌙 Ranni · ${pickRanniSignature(data)}</font>`,
    });
  }

  if (statusColor === 'green' && data?.status === 'completed' && data.messageId) {
    bodyElements.push({
      tag: 'markdown',
      content: `<font color="grey">已完成${data.elapsedSecs ? `  ·  耗时 ${formatElapsed(data.elapsedSecs)}` : ''}  ·  ${data.messageId.slice(0, 24)}...</font>`,
    });
  }

  const isCompleted = statusColor === 'green' && data?.status === 'completed';
  const processingStatusSummary = statusColor === 'blue' ? '⏳ 生成中...' : isCompleted ? '✅ 已完成' : '❌ 执行失败';

  return {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'full',
      summary: { content: processingStatusSummary },
    },
    header: {
      title: { tag: 'plain_text', content: statusText },
      ...(headerSubtitle ? { subtitle: headerSubtitle } : {}),
      template: statusColor,
      padding: '12px 12px 12px 12px',
    },
    body: {
      direction: 'vertical',
      padding: '12px 12px 12px 12px',
      vertical_spacing: '8px',
      elements: bodyElements,
    },
  };
}

function getFeishuVisibilityOptions(chatType?: 'p2p' | 'group'): { showThinking: boolean; showTools: boolean } {
  if (chatType === 'group') {
    return { showThinking: false, showTools: false };
  }
  return {
    showThinking: outputConfig.feishu.showThinkingChain,
    showTools: outputConfig.feishu.showToolChain,
  };
}

function formatElapsed(secs: number): string {
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s > 0 ? `${m}m${s}s` : `${m}m`;
}

// 菈妮人格签名池：按场景分档，同档内按 messageId 稳定轮换
// （卡片流式 update 时选句必须稳定，避免刷新时签名闪动）
// 调性：月之魔女 Ranni——冷冽、克制、有距离感，务实的底子裹在星月意象里
const RANNI_SIGNATURES = {
  // 干过活（有工具调用完成）——事已办妥，冷冽收尾
  worked: [
    '尘埃落定，主人过目。',
    '办妥。此事已入我掌中。',
    '收工。碍事的隐患，一并抹去了。',
    '月光已为你铺好路。',
    '成了——这点小事，不劳你费神。',
    '妥了。风险的影子，我先斩了。',
    '如约完成，你安心便是。',
    'done。剩下的，交给时间。',
  ],
  // 纯问答——点到为止，落子由你
  answered: [
    '话已至此，要落子只需你一句。',
    '答案在此，动手与否，你定。',
    '点到为止——下一步呢？',
    '就这些。想深究，再唤我。',
    '如你所愿。',
    '思路已铺开，走不走这条路，看你。',
    '记下了。何时落地，等你号令。',
  ],
  // 失败——不粉饰，给方向
  failed: [
    '这一步断了。卡点在上，方向由你定。',
    '未竟。要我另辟一途么？',
    '败了——不必粉饰，且看上面的症结。',
    '此路不通。别急，退回来重想。',
    '受阻了。我守在这，你说往哪走。',
  ],
} as const;

function pickRanniSignature(data: StreamCardData): string {
  const pool = data.status === 'failed'
    ? RANNI_SIGNATURES.failed
    : (data.tools && data.tools.some(t => t.status === 'completed'))
      ? RANNI_SIGNATURES.worked
      : RANNI_SIGNATURES.answered;
  // 用 messageId 做稳定 hash 选句：同一条消息多次刷新选中同一句，不同消息各异
  const seed = data.messageId || '';
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return pool[hash % pool.length];
}

export function buildStreamCards(data: StreamCardData, options?: StreamCardBuildOptions): object[] {
  const visibilityOptions = getFeishuVisibilityOptions(data.chatType);
  const allElements = buildStreamCardElements(data, visibilityOptions);
  const statusColor: 'blue' | 'green' | 'red' = data.status === 'processing'
    ? 'blue'
    : data.status === 'completed'
      ? 'green'
      : 'red';
  let baseStatusText: string;
  if (data.status === 'processing') {
    const runningSegment = data.segments
      ?.slice().reverse()
      .find(s => s.type === 'tool' && (s.status === 'running' || s.status === 'pending')) as
      ({ type: 'tool'; name: string; status: string } | undefined);
    const activityHint = runningSegment ? ` · 🔧 ${runningSegment.name}` : '';
    baseStatusText = data.elapsedSecs && data.elapsedSecs >= 60
      ? `处理中... (已等待 ${formatElapsed(data.elapsedSecs)})${activityHint}`
      : `处理中...${activityHint}`;
  } else {
    baseStatusText = data.status === 'completed' ? '已完成' : '失败';
  }
  if (data.currentModel && data.status !== 'completed') {
    baseStatusText = `${baseStatusText} · 模型: ${data.currentModel}`;
  }

  const componentBudget = typeof options?.componentBudget === 'number' && Number.isFinite(options.componentBudget)
    ? Math.floor(options.componentBudget)
    : DEFAULT_STREAM_CARD_COMPONENT_BUDGET;
  const pages = paginateElementsByComponentBudget(allElements, componentBudget);

  if (pages.length <= 1) {
    return [buildStreamCardPayload(pages[0], baseStatusText, statusColor, data)];
  }

  return pages.map((pageElements, index) => {
    const statusText = `${baseStatusText}（${index + 1}/${pages.length}）`;
    return buildStreamCardPayload(pageElements, statusText, statusColor, data);
  });
}

export function buildStreamCard(data: StreamCardData): object {
  return buildStreamCards(data)[0];
}
