# feishu-opencode-bridge 修改项总结

本文档汇总了近期对 feishu-opencode-bridge 所做的全部修改。

---

## 一、稳定性与可靠性改动

### 1.1 飞书 WebSocket 应用层重连

**文件**: `src/feishu/client.ts`

- 每 30 秒检查 `lastMessageAt`，超过 90 秒无消息则主动重连
- 新增环境变量：
  - `FEISHU_WS_RECONNECT_DELAY_MS`：重连间隔（默认 5000ms）
  - `FEISHU_WS_MAX_RECONNECT_ATTEMPTS`：最大重连次数（0=无限）
  - `FEISHU_WS_IDLE_TIMEOUT_MS`：空闲超时（默认 90000ms）
- 新增 `getConnectionStatus()` 方法，返回 `{ connected, lastMessageAt }`

### 1.2 Bridge 进程看门狗

**文件**: `scripts/start.mjs`

- 默认启用看门狗，子进程退出后自动重启
- 1 小时内最多重启 5 次
- 支持 `BRIDGE_WATCHDOG_ENABLED=0` 关闭看门狗，恢复原先 detached 模式

### 1.3 OpenCode 事件流心跳检测

**文件**: `src/opencode/client.ts`

- 每 15 秒检查，60 秒无事件则断开并重连
- 最大退避 30 秒
- 新增 `getConnectionStatus()` 方法，返回 `{ connected, lastHeartbeatAt }`

### 1.4 健康检查端点

**文件**: `src/api/local-api.ts`

- 新增 `GET /health` 端点
- 返回 `feishu`、`opencode` 连接状态
- 任一断开时返回 HTTP 503，body 含 `status: 'degraded'`
- 包含 `feishuLastMessageAt`、`opencodeLastHeartbeatAt` 时间戳

### 1.5 消息解析增强

**文件**: `src/feishu/client.ts`

- 对 `message.content` 做空值和类型校验
- 解析失败时回退到原始字符串

### 1.6 delayed-handler 修复

**文件**: `src/opencode/delayed-handler.ts`

- `cleanupExpired` 中改用 `messageId` 作为 map key 进行删除
- 修复原先误用 `sessionId` 导致的清理错误

### 1.7 配置更新

**文件**: `src/config.ts`

- 增加上述相关环境变量的解析

### 1.8 状态日志

**文件**: `src/index.ts`

- 每 5 分钟输出一次飞书与 OpenCode 连接状态

---

## 二、API 与测试支持改动

### 2.1 local-api 返回 Server 实例

**文件**: `src/api/local-api.ts`

- `startLocalApiServer()` 改为返回 `Server` 实例
- 便于测试中创建并关闭服务，避免端口占用

---

## 三、新增测试

### 3.1 健康检查端点测试

**文件**: `tests/health-endpoint.test.ts`

- 两端连接时返回 200 和 `status: ok`
- 飞书断开时返回 503 和 `status: degraded`
- OpenCode 断开时返回 503 和 `status: degraded`
- 验证 `lastMessageAt`、`lastHeartbeatAt` 时间戳

### 3.2 delayed-handler 测试

**文件**: `tests/opencode/delayed-handler.test.ts`

- `register` 按 `messageId` 索引
- `cleanupExpired` 使用 `messageId` 正确清理（含同 sessionId 多请求场景）
- 未过期请求不被清理

---

## 四、既有失败用例修复

### 4.1 config-env.test.ts

**问题**: `GROUP_REQUIRE_MENTION` 默认值测试受 `.env` 影响

**修复**:
```ts
vi.mock('dotenv/config', () => ({}));
```
- 阻止 dotenv 加载 `.env`，保证测试环境可控

### 4.2 directory-policy.test.ts

**问题**: 在 macOS 上断言了 Windows 路径格式

**修复**: 按平台区分断言
```ts
if (process.platform === 'win32') {
  expect(result).toMatch(/^[A-Za-z]:\\/);
} else {
  expect(result).toMatch(/^\//);
}
```

### 4.3 discord-handler.test.ts

**问题**: `groupConfig.requireMentionInGroup` 为 true 时，群聊消息无 @ 被跳过，权限/问题/普通消息测试无法执行

**修复**:
```ts
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    groupConfig: {
      ...actual.groupConfig,
      requireMentionInGroup: false,
    },
  };
});
```

### 4.4 root-router-mention.test.ts

**问题**: `BOT_OPEN_ID` 与测试 mention 不一致时，会误判为未 @ 机器人而跳过

**修复**:
- 添加 `vi.mock('dotenv/config', () => ({}));`
- 在 `envKeys` 中加入 `BOT_OPEN_ID`
- 测试中设置 `process.env.BOT_OPEN_ID = 'ou_bot'` 与测试事件一致

---

## 五、修改文件清单

| 文件路径 | 修改类型 |
|---------|----------|
| `src/feishu/client.ts` | 稳定性、消息解析、getConnectionStatus |
| `src/opencode/client.ts` | 心跳检测、getConnectionStatus |
| `src/opencode/delayed-handler.ts` | cleanupExpired 修复 |
| `src/api/local-api.ts` | 健康检查端点、返回 Server |
| `src/config.ts` | 新增环境变量 |
| `src/index.ts` | 状态日志 |
| `scripts/start.mjs` | 看门狗 |
| `tests/config-env.test.ts` | 修复 dotenv 干扰 |
| `tests/directory-policy.test.ts` | 平台感知断言 |
| `tests/discord-handler.test.ts` | 修复 config mock |
| `tests/root-router-mention.test.ts` | 修复 dotenv、BOT_OPEN_ID |
| `tests/health-endpoint.test.ts` | **新增** |
| `tests/opencode/delayed-handler.test.ts` | **新增** |

---

## 六、验证结果

- **构建**: `npm run build` 通过
- **测试**: `npm test` 共 120 个用例全部通过
- **健康检查**: `curl http://127.0.0.1:4097/health` 可正常返回状态
