# feishu-opencode-bridge 消息通信桥接代码审查报告

**项目路径**: `~/.config/opencode/feishu-opencode-bridge/`  
**审查日期**: 2026-03-12

---

## 一、架构与数据流概览

```
飞书消息 (WebSocket/Webhook)
    ↓
feishuClient.on('message') → rootRouter.onMessage
    ↓
p2pHandler / groupHandler.handleMessage
    ↓
chatSessionStore.setSession(chatId, sessionId, ...)
    ↓
processPrompt → opencodeClient.sendMessagePartsAsync
    ↓
OpenCode 处理 (prompt_async)
    ↓
事件流: 全局 subscribe() + 目录 subscribe({ directory })
    ↓
handleEvent → messagePartUpdated / sessionIdle / sessionError ...
    ↓
handleMessagePartUpdated: chatSessionStore.getChatId(sessionID) → 路由
    ↓
outputBuffer.append / appendThinking / touch
    ↓
scheduleUpdate → triggerUpdate → setUpdateCallback
    ↓
buildStreamCards → feishuAdapter.sendCard / updateCard
    ↓
飞书展示卡片
```

---

## 二、分项审查

### 2.1 消息入站：飞书 → 路由 → Handler → OpenCode

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 飞书消息接收 | ✅ | `feishu/client.ts` 解析 `chat_id`、`message_id`、`sender_id`、`chat_type`、`mentions` |
| 路由分发 | ✅ | `root-router.ts` 按 `chatType` 分发到 p2p/group，支持权限文本、@ 过滤 |
| 群聊 @ 要求 | ✅ | `groupConfig.requireMentionInGroup` 控制，`botOpenId` 过滤 |
| 私聊入口 | ✅ | p2p 先 `ensurePrivateSession`，再委托 `groupHandler.handleMessage` |
| 会话创建 | ✅ | `createSession` + `chatSessionStore.setSession`，含 `resolvedDirectory`、`chatType` |
| 发送到 OpenCode | ✅ | `sendMessagePartsAsync`，支持 `directory`、`providerId`、`modelId`、`variant` |

**潜在问题**：
- 无：流程完整

---

### 2.2 会话管理：chatSessionStore

| 检查项 | 状态 | 说明 |
|--------|------|------|
| sessionId ↔ chatId 映射 | ✅ | `setSession` 写 `feishu:${chatId}`，`getChatId` 反向查 |
| getConversationBySessionId | ✅ | 遍历 data 匹配 sessionId，返回 `{ platform, conversationId }` |
| 会话别名 | ✅ | `rememberSessionAlias` 临时映射，TTL 10 分钟 |
| chatType 存储 | ✅ | `setSession` 写入 `chatType`，`isGroupChatSession` / `isP2PChatSession` 正确判断 |
| 持久化 | ✅ | `.chat-sessions.json` 保存，启动时 load |

**潜在问题**：
- 无：映射逻辑正确，已修复 `chatTypeForCard` 使用 `isGroupChatSession`

---

### 2.3 事件出站：OpenCode 事件流

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 全局事件流 | ✅ | `startEventListener` 连接 `event.subscribe()`，接收所有事件 |
| 目录事件流 | ✅ | `ensureDirectoryEventStream(directory)` 按目录订阅 |
| 发送前订阅 | ✅ | `sendMessagePartsAsync` 中 `await ensureDirectoryEventStream`，避免漏收 |
| 事件类型 | ✅ | `message.part.updated`、`message.part.delta`、`session.idle`、`session.error` 等 |
| sessionID 解析 | ✅ | `handleEvent` 从 `props` / `part` 多字段取 sessionID |
| message.part.delta | ✅ | 不参与 dedup，构造最小 part 后 emit `messagePartUpdated` |

**潜在问题**：
- 无 directory 时依赖全局流，已加 `[Group] 未解析到 session 目录` 日志

---

### 2.4 事件处理：handleMessagePartUpdated

| 检查项 | 状态 | 说明 |
|--------|------|------|
| chatId 解析 | ✅ | `chatSessionStore.getChatId(sessionID)`，失败时打 warn 并跳过 |
| bufferKey 一致性 | ✅ | `chat:${conversationId}` 与 group handler 的 `chat:${chatId}` 一致 |
| 用户消息过滤 | ✅ | `isUserMessagePart` 过滤用户 part |
| tool/subtask 处理 | ✅ | `upsertToolState`、timeline、`outputBuffer.touch` |
| delta 处理 | ✅ | 字符串/对象，reasoning/text 分支完整 |
| part 快照 | ✅ | `appendTextFromPart`、`appendReasoningFromPart` 处理无 id 的 part |

**潜在问题**：
- 无：逻辑完整

---

### 2.5 输出缓冲：outputBuffer

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 创建时机 | ✅ | `ensureStreamingBuffer` 在 processPrompt 前调用 |
| append / appendThinking | ✅ | 写入 content/thinking，`scheduleUpdate` |
| 更新间隔 | ✅ | `outputConfig.updateInterval` 默认 3000ms |
| 并发防护 | ✅ | `buffer.isUpdating` 防止回调重入，dirty 标记重调度 |
| getAndClear | ✅ | 回调中清空 content/thinking，与 streamContentMap 累加 |
| 状态驱动 | ✅ | `setStatus` 触发 `triggerUpdate`，completed/failed 立即刷新 |

**潜在问题**：
- 无：`isUpdating` 串行化正确

---

### 2.6 卡片发送：buildStreamCards → 飞书

| 检查项 | 状态 | 说明 |
|--------|------|------|
| chatType 判断 | ✅ | `chatSessionStore.isGroupChatSession(conversationId)`，群聊隐藏 thinking/tools |
| 可见内容过滤 | ✅ | 群聊仅 text、note、pendingPermission、pendingQuestion |
| 分页 | ✅ | `paginateElementsByComponentBudget`，componentBudget=180 |
| existingMessageIds | ✅ | 来自 `streamCardMessageIdsMap` 或 `buffer.messageId` |
| 更新 vs 发送 | ✅ | 有 existingMessageId 则 updateCard，失败则 sendCard+delete 旧卡 |
| 冗余卡片清理 | ✅ | `cards.length < existingMessageIds.length` 时 delete 多余 |
| upsertLiveCardInteraction | ✅ | 记录 interaction，用于后续查找 |

**潜在问题**：
- 无：流程正确

---

### 2.7 边界情况

#### 2.7.1 Compaction

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 检测 | ✅ | `session.updated` 中 `time.compacting` |
| 消息入队 | ✅ | `enqueueCompactionMessage`，replayHandler 重放 |
| 完成时重发 | ✅ | `flushCompactionQueue` 在 sessionStatus(idle)、sessionIdle 时触发 |

#### 2.7.2 权限请求

| 检查项 | 状态 | 说明 |
|--------|------|------|
| 路由解析 | ✅ | `resolvePermissionChat`：session → parent → related → tool_call → message |
| 相关性缓存 | ✅ | `toolCallChatMap`、`messageChatMap`，TTL 10 分钟 |
| hasConversationId | ✅ | `getCorrelationChatRef` 校验会话仍存在 |

#### 2.7.3 问答

| 检查项 | 状态 | 说明 |
|--------|------|------|
| questionAsked | ✅ | `handleQuestionAsked`，`questionHandler.register` |
| getPendingQuestionForBuffer | ✅ | 注入到 context，卡片展示 pendingQuestion |

#### 2.7.4 错误处理

| 检查项 | 状态 | 说明 |
|--------|------|------|
| sessionError | ✅ | `applyFailureToSession`，resolveSessionConversation 失败则静默 |
| 静默超时 | ✅ | `outputConfig.silenceTimeoutMs`，无内容时 append 提示 |
| 发送失败 | ✅ | `formatDispatchError`，outputBuffer.append 错误文本 |

---

## 三、已修复项（本次会话）

| 修复 | 文件 | 说明 |
|------|------|------|
| chatTypeForCard | index.ts | `conversationId.startsWith('oc_')` → `chatSessionStore.isGroupChatSession(conversationId)` |
| 事件流订阅时机 | opencode/client.ts | `void ensureDirectoryEventStream` → `await ensureDirectoryEventStream` |
| 无会话映射日志 | opencode-event-hub.ts | `getChatId` 为 null 时打 warn |
| 无目录日志 | group.ts | 未解析到 directory 时打 warn |

---

## 四、潜在风险与建议

### P1：outputConfig.updateInterval 默认 3 秒

- **影响**：首条流式内容可能延迟 3 秒才发卡
- **建议**：可考虑将默认调低至 1500–2000ms，或首包缩短间隔

### P2：applyFailureToSession 静默失败

- **位置**：`index.ts:1316-1317`
- **现象**：`resolveSessionConversation(sessionID)` 为 null 时直接 return，用户无提示
- **建议**：可加 `console.warn`，便于排查

### P3：replayHandler 未注册时 compaction 消息丢失

- **位置**：`opencode-event-hub.ts:240-242`
- **现象**：`!this.replayHandler` 时仅 warn，不重发
- **建议**：确认 group handler 的 `setReplayHandler` 在 EventHub 注册前完成（当前在 group 构造时设置，应无问题）

---

## 五、关键文件索引

| 文件 | 职责 |
|------|------|
| `src/index.ts` | 主入口、context 注入、outputBuffer 回调、applyFailureToSession |
| `src/feishu/client.ts` | 飞书消息收发、addReaction、sendCard/updateCard |
| `src/handlers/group.ts` | 群聊处理、processPrompt、ensureStreamingBuffer |
| `src/handlers/p2p.ts` | 私聊入口、ensurePrivateSession、委托 groupHandler |
| `src/router/opencode-event-hub.ts` | OpenCode 事件分发、handleMessagePartUpdated |
| `src/opencode/client.ts` | OpenCode 连接、事件流、sendMessagePartsAsync |
| `src/opencode/output-buffer.ts` | 缓冲、scheduleUpdate、triggerUpdate |
| `src/store/chat-session.ts` | session 映射、getChatId、isGroupChatSession |
| `src/feishu/cards-stream.ts` | buildStreamCards、getFeishuVisibilityOptions |

---

## 六、结论

**数据流**：飞书 → Handler → OpenCode → 事件流 → EventHub → outputBuffer → 飞书 的链路完整，无断点。

**会话映射**：`sessionId ↔ chatId` 通过 chatSessionStore 维护，含别名与持久化。

**事件流**：全局 + 目录双流，发送前 await 目录流建立，避免漏收。

**并发**：outputBuffer 的 `isUpdating` 防止回调重入。

**当前状态**：消息通信桥接逻辑正常，已修复 chatType 判断与事件流订阅时机。若仍出现「无回复」，可重点查看：
1. `[EventHub] messagePartUpdated 无会话映射`：session 未正确绑定
2. `[Group] 未解析到 session 目录`：依赖全局流，需确认 OpenCode 全局流正常
