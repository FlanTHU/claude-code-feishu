import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Server } from 'http';

const mockGetFeishuStatus = vi.fn();
const mockGetOpencodeStatus = vi.fn();

vi.mock('../src/feishu/client.js', () => ({
  feishuClient: {
    getConnectionStatus: () => mockGetFeishuStatus(),
  },
}));

vi.mock('../src/opencode/client.js', () => ({
  opencodeClient: {
    getConnectionStatus: () => mockGetOpencodeStatus(),
  },
}));

async function fetchHealth(port: number): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/health`);
  const body = (await res.json()) as unknown;
  return { status: res.status, body };
}

describe('健康检查端点 /health', () => {
  const TEST_PORT = 15497;
  let server: Server;

  beforeEach(async () => {
    vi.resetModules();
    mockGetFeishuStatus.mockReset();
    mockGetOpencodeStatus.mockReset();
    process.env.BRIDGE_API_PORT = String(TEST_PORT);
    const { startLocalApiServer } = await import('../src/api/local-api.js');
    server = startLocalApiServer();
    await new Promise<void>(resolve => {
      server.on('listening', () => resolve());
    });
  });

  afterEach(() => {
    server?.close();
    delete process.env.BRIDGE_API_PORT;
  });

  it('两端都连接时应返回 200 和 status ok', async () => {
    mockGetFeishuStatus.mockReturnValue({ connected: true, lastMessageAt: 1234567890 });
    mockGetOpencodeStatus.mockReturnValue({ connected: true, lastHeartbeatAt: 1234567890 });

    const { status, body } = await fetchHealth(TEST_PORT);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: 'ok',
      port: TEST_PORT,
      feishu: 'ok',
      opencode: 'ok',
    });
  });

  it('飞书断开时应返回 503 和 status degraded', async () => {
    mockGetFeishuStatus.mockReturnValue({ connected: false, lastMessageAt: 0 });
    mockGetOpencodeStatus.mockReturnValue({ connected: true, lastHeartbeatAt: 1234567890 });

    const { status, body } = await fetchHealth(TEST_PORT);

    expect(status).toBe(503);
    expect(body).toMatchObject({
      status: 'degraded',
      feishu: 'disconnected',
      opencode: 'ok',
    });
  });

  it('OpenCode 断开时应返回 503 和 status degraded', async () => {
    mockGetFeishuStatus.mockReturnValue({ connected: true, lastMessageAt: 1234567890 });
    mockGetOpencodeStatus.mockReturnValue({ connected: false, lastHeartbeatAt: 0 });

    const { status, body } = await fetchHealth(TEST_PORT);

    expect(status).toBe(503);
    expect(body).toMatchObject({
      status: 'degraded',
      feishu: 'ok',
      opencode: 'disconnected',
    });
  });

  it('应包含 lastMessageAt 和 lastHeartbeatAt 时间戳', async () => {
    const ts = Date.now();
    mockGetFeishuStatus.mockReturnValue({ connected: true, lastMessageAt: ts });
    mockGetOpencodeStatus.mockReturnValue({ connected: true, lastHeartbeatAt: ts });

    const { body } = await fetchHealth(TEST_PORT);

    expect(body).toMatchObject({
      feishuLastMessageAt: ts,
      opencodeLastHeartbeatAt: ts,
    });
  });
});
