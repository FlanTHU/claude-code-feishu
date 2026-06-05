import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { delayedResponseHandler } from '../../src/opencode/delayed-handler.js';
import type { PendingRequest } from '../../src/opencode/delayed-handler.js';

function makeRequest(overrides: Partial<PendingRequest>): PendingRequest {
  return {
    conversationKey: 'conv-1',
    chatId: 'chat-1',
    sessionId: 'session-1',
    messageId: 'msg-' + Math.random().toString(36).slice(2, 10),
    feishuMessageId: 'feishu-1',
    createdAt: Date.now(),
    callback: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('DelayedResponseHandler', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // 清空所有待处理请求
    delayedResponseHandler.getAll().forEach(r => delayedResponseHandler.remove(r.messageId));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('register 应按 messageId 索引，get 可正确获取', () => {
    const req = makeRequest({ messageId: 'msg-abc', sessionId: 's1' });
    delayedResponseHandler.register(req);

    expect(delayedResponseHandler.get('msg-abc')).toBeDefined();
    expect(delayedResponseHandler.get('msg-abc')?.sessionId).toBe('s1');
    expect(delayedResponseHandler.has('msg-abc')).toBe(true);
  });

  it('cleanupExpired 应使用 messageId 作为 key 正确清理', () => {
    const now = Date.now();
    const req1 = makeRequest({
      messageId: 'msg-1',
      sessionId: 'same-session',
      createdAt: now - 10000,
    });
    const req2 = makeRequest({
      messageId: 'msg-2',
      sessionId: 'same-session',
      createdAt: now - 10000,
    });

    delayedResponseHandler.register(req1);
    delayedResponseHandler.register(req2);
    expect(delayedResponseHandler.size).toBe(2);

    const expired = delayedResponseHandler.cleanupExpired(5000);

    expect(expired).toHaveLength(2);
    expect(expired.map(e => e.messageId).sort()).toEqual(['msg-1', 'msg-2']);
    expect(delayedResponseHandler.get('msg-1')).toBeUndefined();
    expect(delayedResponseHandler.get('msg-2')).toBeUndefined();
    expect(delayedResponseHandler.size).toBe(0);
  });

  it('cleanupExpired 不应清理未过期的请求', () => {
    const now = Date.now();
    const req = makeRequest({
      messageId: 'msg-recent',
      createdAt: now - 1000,
    });
    delayedResponseHandler.register(req);

    const expired = delayedResponseHandler.cleanupExpired(5000);

    expect(expired).toHaveLength(0);
    expect(delayedResponseHandler.get('msg-recent')).toBeDefined();
    expect(delayedResponseHandler.size).toBe(1);
  });
});
