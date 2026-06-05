import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'http';
import { chatSessionStore } from '../store/chat-session.js';
import { sendFileToFeishu } from '../handlers/file-sender.js';
import { feishuClient } from '../feishu/client.js';
import { activeBackend } from '../backend/active.js';

type CardBody = { chatId?: unknown; card?: unknown };

const API_PORT = parseInt(process.env.BRIDGE_API_PORT || '4097', 10);

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJSON(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function isLocalRequest(req: IncomingMessage): boolean {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// 持有 server 引用，供 graceful shutdown 调用
let _server: Server | null = null;

export function stopLocalApiServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!_server) {
      resolve();
      return;
    }
    _server.close((err) => {
      if (err) {
        console.warn('[LocalAPI] 关闭时出错（忽略）:', err.message);
      } else {
        console.log('[LocalAPI] 本地 API 服务已关闭');
      }
      _server = null;
      resolve();
    });
    // 强制关闭所有 keep-alive 连接，避免 close() 挂起
    _server.closeAllConnections?.();
  });
}

export function startLocalApiServer(): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!isLocalRequest(req)) {
      sendJSON(res, 403, { error: '仅允许本机请求' });
      return;
    }

    const url = req.url || '';
    const method = req.method || '';

    if (method === 'POST' && url === '/api/send-file') {
      let body: { filePath?: unknown; chatId?: unknown };
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw) as { filePath?: unknown; chatId?: unknown };
      } catch {
        sendJSON(res, 400, { error: '请求体必须是合法 JSON' });
        return;
      }

      const filePath = typeof body.filePath === 'string' ? body.filePath.trim() : '';
      if (!filePath) {
        sendJSON(res, 400, { error: '缺少 filePath 字段' });
        return;
      }

      let targetChatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
      if (!targetChatId) {
        const allSessions = chatSessionStore.getAllSessions();
        const groupSession = allSessions.find(s => s.chatType === 'group');
        if (groupSession) {
          targetChatId = groupSession.chatId;
        }
      }

      if (!targetChatId) {
        sendJSON(res, 400, { error: '未指定 chatId 且没有活跃的群聊会话' });
        return;
      }

      console.log(`[LocalAPI] 发送文件: path=${filePath}, chatId=${targetChatId}`);

      const result = await sendFileToFeishu({ filePath, chatId: targetChatId, bypassPathCheck: true });

      if (result.success) {
        console.log(`[LocalAPI] 文件发送成功: ${result.fileName} (${result.sendType})`);
        sendJSON(res, 200, {
          success: true,
          fileName: result.fileName,
          fileSize: result.fileSize,
          sendType: result.sendType,
          messageId: result.messageId,
        });
      } else {
        console.warn(`[LocalAPI] 文件发送失败: ${result.error}`);
        sendJSON(res, 500, { success: false, error: result.error });
      }
      return;
    }

    if (method === 'POST' && url === '/api/send-message') {
      let body: { chatId?: unknown; text?: unknown; mentions?: unknown };
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw) as { chatId?: unknown; text?: unknown; mentions?: unknown };
      } catch {
        sendJSON(res, 400, { error: '请求体必须是合法 JSON' });
        return;
      }

      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) {
        sendJSON(res, 400, { error: '缺少 text 字段' });
        return;
      }

      let targetChatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
      if (!targetChatId) {
        const allSessions = chatSessionStore.getAllSessions();
        const session = allSessions.find(s => s.chatType === 'group') ?? allSessions[0];
        if (session) targetChatId = session.chatId;
      }

      if (!targetChatId) {
        sendJSON(res, 400, { error: '未指定 chatId 且没有活跃会话' });
        return;
      }

      const mentions = Array.isArray(body.mentions)
        ? (body.mentions as Array<{ openId?: unknown; name?: unknown }>)
            .filter(m => typeof m.openId === 'string' && typeof m.name === 'string')
            .map(m => ({ openId: m.openId as string, name: m.name as string }))
        : [];

      console.log(`[LocalAPI] 发送消息: chatId=${targetChatId}, mentions=${mentions.length}`);

      const msgId = mentions.length > 0
        ? await feishuClient.sendMentionText(targetChatId, mentions, text)
        : await feishuClient.sendText(targetChatId, text);

      if (msgId) {
        sendJSON(res, 200, { success: true, messageId: msgId });
      } else {
        sendJSON(res, 500, { success: false, error: '发送失败' });
      }
      return;
    }

    if (method === 'POST' && url === '/api/send-card') {
      let body: CardBody;
      try {
        const raw = await readBody(req);
        body = JSON.parse(raw) as CardBody;
      } catch {
        sendJSON(res, 400, { error: '请求体必须是合法 JSON' });
        return;
      }

      if (!body.card || typeof body.card !== 'object') {
        sendJSON(res, 400, { error: '缺少 card 字段（object）' });
        return;
      }

      let targetChatId = typeof body.chatId === 'string' ? body.chatId.trim() : '';
      if (!targetChatId) {
        const allSessions = chatSessionStore.getAllSessions();
        const session = allSessions.find(s => s.chatType === 'group') ?? allSessions[0];
        if (session) targetChatId = session.chatId;
      }

      if (!targetChatId) {
        sendJSON(res, 400, { error: '未指定 chatId 且没有活跃会话' });
        return;
      }

      // 剔除会触发飞书 230099 错误的 config.update_multi 字段
      // update_multi 仅用于 streamer 内部流式更新，手动发卡不应携带
      const card = body.card as Record<string, unknown>;
      if (card.config && typeof card.config === 'object') {
        const cfg = { ...(card.config as Record<string, unknown>) };
        delete cfg.update_multi;
        card.config = Object.keys(cfg).length > 0 ? cfg : undefined;
      }

      console.log(`[LocalAPI] 发送卡片: chatId=${targetChatId}`);
      const msgId = await feishuClient.sendCard(targetChatId, card);

      if (msgId) {
        sendJSON(res, 200, { success: true, messageId: msgId });
      } else {
        sendJSON(res, 500, { success: false, error: '发送失败' });
      }
      return;
    }

    if (method === 'GET' && url === '/health') {
      const feishuStatus = feishuClient.getConnectionStatus();
      const opencodeStatus = activeBackend.getConnectionStatus();
      const feishuOk = feishuStatus.connected;
      const opencodeOk = opencodeStatus.connected;
      const overallOk = feishuOk && opencodeOk;
      sendJSON(res, overallOk ? 200 : 503, {
        status: overallOk ? 'ok' : 'degraded',
        port: API_PORT,
        feishu: feishuOk ? 'ok' : 'disconnected',
        feishuLastMessageAt: feishuStatus.lastMessageAt || undefined,
        opencode: opencodeOk ? 'ok' : 'disconnected',
        opencodeLastHeartbeatAt: opencodeStatus.lastHeartbeatAt || undefined,
      });
      return;
    }

    sendJSON(res, 404, { error: '未知接口' });
  });

  server.listen({ host: '127.0.0.1', port: API_PORT, exclusive: false }, () => {
    console.log(`[LocalAPI] 本地 API 服务已启动: http://127.0.0.1:${API_PORT}`);
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    console.error(`[LocalAPI] 服务错误 (${err.code}):`, err.message);
  });

  _server = server;
  return server;
}
