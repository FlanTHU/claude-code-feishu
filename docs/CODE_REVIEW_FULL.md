# feishu-opencode-bridge 完整代码审查报告

**项目路径**: `~/.config/opencode/feishu-opencode-bridge/`  
**审查日期**: 2026-03-12  
**最后更新**: 2026-03-17（P0/P1/P2 修复状态同步）  
**范围**: 近期修改后的全量代码

---

## 一、潜在 Bug（按严重程度）

### P0：流式文本重复字符丢失 ✅ 已修复（2026-03-17）

**位置**: `src/opencode/client.ts` 第 663-675 行

**问题**: `message.part.delta` 的 dedup 使用 `deltaKey = partId:field:delta`。当模型输出包含重复字符（如 "hello" 中的两个 "l"）时，两次 "l" 的 delta 会产生相同 key，第二次在 50ms 内会被误判为重复而跳过。

**影响**: 流式输出中重复字符丢失，例如 "hello" → "helo"。

**修复建议**:
```typescript
// 方案 A：delta 不按内容 dedup，仅按 (sessionId, messageId, partId, 递增序号) 去重
// 需要 OpenCode 事件带序号，若无则不可行

// 方案 B：delta 不做跨流 dedup，仅依赖上游单流
// 若只有单路流，可移除 delta 的 recentDeltaKeys 逻辑

// 方案 C：deltaKey 加入时间戳或纳秒，使同一内容的连续 delta 区分开
// 例如: `${partId}:${field}:${now}:${delta.slice(-20)}` 或使用递增 counter
```

**推荐**: 若存在主/目录双流 echo，可改为按 `sessionId:messageId:partId:field` + 短窗口（如 10ms）仅过滤「完全同时」的 echo，而不按 delta 内容。或为 delta 增加单调递增的 sequence 字段参与 key。

---

### P1：part 乱序/回退导致内容重复 ✅ 已修复（2026-03-17）

**位置**: `src/index.ts` 第 789-832 行，`appendTextFromPart` / `appendReasoningFromPart`

**问题**: 当 `current !== prev` 且 `!current.startsWith(prev)` 时，会 `outputBuffer.append(bufferKey, current)`。若收到的是旧快照（如 prev="hello world", current="hello"），会向 buffer 追加 "hello"，导致 "hello worldhello"。

**影响**: 乱序或重试场景下，文本重复或错乱。

**修复建议**:
```typescript
// 在 appendTextFromPart 中，else if (current !== prev) 分支前增加：
if (prev.length > 0 && prev.startsWith(current) && current.length < prev.length) {
  // 收到更短的快照，可能是乱序，跳过
  return;
}
```

---

### P1：applyFailureToSession 静默失败 ✅ 已修复（2026-03-17）

**位置**: `src/index.ts` 第 1315-1318 行

**问题**: `resolveSessionConversation(sessionID)` 为 null 时直接 return，用户无任何错误提示。

**修复建议**: 增加 warn 日志，便于排查：
```typescript
if (!conversation) {
  console.warn(`[Index] applyFailureToSession 无法解析会话: sessionID=${sessionID?.slice(0, 12)}...`);
  return;
}
```

---

### P2：addInteraction 在 session 不存在时静默跳过 ✅ 已修复（2026-03-17） ✅ 已修复

**位置**: `src/store/chat-session.ts` 第 559-576 行

**修复**: 增加 `console.debug` 日志，便于排查。

---

### P2：message.part.updated 无 TTL 导致长期去重 ✅ 已修复（2026-03-17） ✅ 已修复

**位置**: `src/opencode/client.ts` 第 683-687 行

**修复**: 改为 `now - lastSeen < dedupTtlMs`（60s），避免永久去重导致漏处理。

---

## 二、优化方向

### 1. 内存与 Map 清理

| 项目 | 现状 | 建议 |
|------|------|------|
| streamContentMap | buffer 结束时 delete | ✅ 已清理 |
| reasoningSnapshotMap / textSnapshotMap | 按 sessionId 前缀清理 | ✅ clearPartSnapshotsForSession |
| userMessageIdsBySession | 仅 sessionIdle 时 clearUserMessageIds | 可增加按 session 的 TTL 或上限 |
| toolCallChatMap / messageChatMap | 依赖 hasConversationId 校验 | ✅ 过期与会话校验已有 |
| compactionMessageQueue | flush 后 delete | ✅ 已清理 |

**建议**: `userMessageIdsBySession` 的 Set 可限制 size（如 50），防止单 session 长期积累。

---

### 2. 输出延迟

| 项目 | 现状 | 建议 |
|------|------|------|
| outputConfig.updateInterval | 默认 3000ms | 可调低至 1500–2000ms 改善首包延迟 |
| scheduleUpdate 防抖 | 有 timer 则不重复调度 | ✅ 合理 |

---

### 3. 错误处理与可观测性

| 项目 | 建议 |
|------|------|
| removeTypingReaction 失败 | 当前 `catch(() => undefined)` 静默，可加 debug 日志 |
| sendCard / updateCard 失败 | 已有 fallback，可考虑重试一次 |
| OpenCode 事件流断开 | 已有 scheduleEventReconnect，可增加断开/重连的 metrics |

---

### 4. 类型与结构

| 项目 | 建议 |
|------|------|
| index.ts 体积 | 约 1500 行，可拆出 `stream-helpers.ts`、`permission-helpers.ts` |
| OpenCodeEventContext | 字段较多，可分组为子对象注入 |
| TimelineSegment 类型 | 在 index 与 event-hub 中重复定义，可统一到公共类型 |

---

### 5. 并发与竞态

| 项目 | 现状 | 评估 |
|------|------|------|
| outputBuffer 回调 | isUpdating 防重入 | ✅ 安全 |
| streamCardMessageIdsMap | 单线程更新 | ✅ 无竞态 |
| chatSessionStore | 同步读写 | ✅ 无竞态 |
| 飞书 onMessage | 无全局限流 | 高并发时可能压垮 OpenCode，可考虑 p-queue |

---

## 三、模块级检查摘要

| 模块 | 潜在问题 | 优化建议 |
|------|----------|----------|
| index.ts | applyFailureToSession 静默、appendTextFromPart 乱序 | 见上文 P1 |
| opencode/client.ts | delta dedup 误杀重复字符 | 见上文 P0 |
| opencode-event-hub.ts | 无 | 日志与结构可优化 |
| handlers/group.ts | 无 | 目录解析日志已有 |
| store/chat-session.ts | addInteraction 静默跳过 | 可选 debug 日志 |
| output-buffer.ts | 无 | updateInterval 可配置 |
| permissions/handler.ts | 无 | - |
| feishu/client.ts | 无 | - |

---

## 四、修复优先级建议

1. **P0** ✅：修复 delta dedup 导致的重复字符丢失（影响流式输出正确性）
2. **P1** ✅：appendTextFromPart 乱序防护、applyFailureToSession 日志
3. **P2** ✅：message.part.updated 的 TTL、addInteraction 文档/日志
4. **优化**：updateInterval、index 拆分、限流等可排期

---

## 五、关键文件索引

| 文件 | 职责 |
|------|------|
| src/index.ts | 主入口、context、outputBuffer 回调、权限解析 |
| src/opencode/client.ts | OpenCode 连接、事件流、dedup、sendMessagePartsAsync |
| src/router/opencode-event-hub.ts | 事件分发、handleMessagePartUpdated |
| src/handlers/group.ts | 群聊、processPrompt、ensureStreamingBuffer |
| src/store/chat-session.ts | session 映射、interaction、isGroupChatSession |
| src/opencode/output-buffer.ts | 缓冲、scheduleUpdate、triggerUpdate |
| src/feishu/cards-stream.ts | buildStreamCards、getFeishuVisibilityOptions |
