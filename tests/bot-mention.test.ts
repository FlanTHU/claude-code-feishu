import { describe, it, expect } from 'vitest';
import { parseBotMentions } from '../src/feishu/bot-mention.js';

const YUANQIXIA = 'ou_307af3345f15d80ed7bfb01c1dfee728';
const OTHER = 'ou_aee1bc4fbd24d393a9fde42d64fa6ea2';
const allowed = new Set([YUANQIXIA, OTHER]);

describe('parseBotMentions', () => {
  it('抽取白名单内的 open_id 并从正文剥离标记', () => {
    const { text, openIds } = parseBotMentions(`你好 @@mention:${YUANQIXIA}@@ 看下这个`, allowed);
    expect(openIds).toEqual([YUANQIXIA]);
    expect(text).toBe('你好 看下这个');
  });

  it('多个标记去重并保持出现顺序', () => {
    const input = `@@mention:${OTHER}@@ a @@mention:${YUANQIXIA}@@ b @@mention:${OTHER}@@`;
    const { openIds } = parseBotMentions(input, allowed);
    expect(openIds).toEqual([OTHER, YUANQIXIA]);
  });

  it('白名单外的 id 不进 openIds，但标记仍从正文剥离', () => {
    const stranger = 'ou_deadbeefdeadbeefdeadbeefdeadbeef';
    const { text, openIds } = parseBotMentions(`hi @@mention:${stranger}@@ there`, allowed);
    expect(openIds).toEqual([]);
    expect(text).toBe('hi there');
    expect(text).not.toContain('@@mention');
  });

  it('无标记时原样返回（trim 后）', () => {
    const { text, openIds } = parseBotMentions('普通回复，没有 @', allowed);
    expect(openIds).toEqual([]);
    expect(text).toBe('普通回复，没有 @');
  });

  it('正文仅含标记时剥离后为空字符串', () => {
    const { text, openIds } = parseBotMentions(`@@mention:${YUANQIXIA}@@`, allowed);
    expect(openIds).toEqual([YUANQIXIA]);
    expect(text).toBe('');
  });
});
