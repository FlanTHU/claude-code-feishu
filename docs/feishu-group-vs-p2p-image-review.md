# 飞书 Bot 群聊 vs 私聊机制 Review：图片接收差异

## 一、架构概览

### 1.1 消息流转路径

```
飞书 WebSocket/事件
    ↓
feishu/client.ts 解析消息 → FeishuMessageEvent (含 content, msgType, attachments)
    ↓
root-router.ts onMessage()
    ↓
    ├─ chatType=p2p  → p2pHandler.handleMessage(event)
    │                      └─ 委托 groupHandler.handleMessage(event)  // 复用同一套处理逻辑
    │
    └─ chatType=group → [先检查 shouldSkipGroupMessage]
                           ├─ 跳过 → return（消息被丢弃，不进入 groupHandler）
                           └─ 不跳过 → groupHandler.handleMessage(event)
```

### 1.2 关键差异

| 维度 | 私聊 (p2p) | 群聊 (group) |
|------|------------|--------------|
| **路由前置条件** | 无，直接进入 p2pHandler | 需通过 `shouldSkipGroupMessage` |
| **@ 要求** | 无 | `GROUP_REQUIRE_MENTION=true` 时必须有 @bot |
| **消息处理** | p2p 委托给 groupHandler，逻辑相同 | 直接由 groupHandler 处理 |
| **附件解析** | 同 client 解析，无差异 | 同 client 解析，无差异 |
| **附件下载** | 同 `downloadMessageResource` | 同 `downloadMessageResource` |
| **附件转 OpenCode** | 同 `prepareAttachmentParts` | 同 `prepareAttachmentParts` |

---

## 二、图片/附件解析流程（client.ts）

### 2.1 解析逻辑（群聊与私聊共用）

```typescript
// feishu/client.ts 约 493-564 行
// 1. msgType === 'image' 时，从 parsedContent 提取 image_key
if (parsedContent && msgType === 'image') {
  const imageKey = getString(parsedContent.image_key) || getString(parsedContent.imageKey);
  if (imageKey) addAttachment({ type: 'image', fileKey: imageKey });
}

// 2. 递归遍历 content 中所有 image_key/file_key
const collected = collectAttachmentsFromContent(parsedContent);
```

- 飞书群聊和私聊的图片消息格式一致：`msg_type: 'image'`，`content` 含 `image_key`
- 解析逻辑对群聊和私聊完全相同，无分支差异

### 2.2 纯图片消息的 content

- 纯图片消息通常无文本：`parsedContent.text` 为空
- 解析后：`content = ''`，`attachments = [{ type: 'image', fileKey: '...' }]`

---

## 三、根因：群聊 @ 门控导致纯图片被跳过

### 3.1 shouldSkipGroupMessage 逻辑

```typescript
// root-router.ts 约 90-114 行
private shouldSkipGroupMessage(event: FeishuMessageEvent): boolean {
  if (event.chatType !== 'group') return false;
  if (!groupConfig.requireMentionInGroup) return false;  // 未启用则不过滤
  if (groupConfig.triggerKeywords.length > 0 && 关键词命中) return false;
  if (!event.mentions || event.mentions.length === 0) return true;  // ⚠️ 无 @ 则跳过
  return !event.mentions.some(m => selfOpenIds.has(m.id.open_id));
}
```

### 3.2 纯图片消息在群聊中的表现

| 条件 | 纯图片消息 |
|------|------------|
| content | `''`（无文本） |
| mentions | `[]`（用户未 @ 任何人） |
| attachments | `[{ type: 'image', fileKey: '...' }]` |

当 `GROUP_REQUIRE_MENTION=true` 时：

1. `event.mentions` 为空
2. `shouldSkipGroupMessage` 返回 `true`
3. 消息在 root-router 中被直接 `return`，**从未进入 groupHandler**
4. 附件解析、下载、多模态能力均未执行

### 3.3 私聊为何正常

- `chatType === 'p2p'` 时，`shouldSkipGroupMessage` 直接返回 `false`
- 消息必定进入 p2pHandler，再委托给 groupHandler
- 附件处理逻辑与群聊一致，因此私聊图片能正常识别并解读

---

## 四、其他可能影响点（已排除）

### 4.1 飞书 API 格式

- 群聊和私聊图片消息的 `msg_type`、`content` 结构一致
- 无证据表明飞书对群聊/私聊图片有不同格式

### 4.2 附件下载

- `downloadMessageResource` 使用 `message_id` + `file_key`，与 chat_type 无关
- 权限要求相同：`im:message:read_as_user` 等

### 4.3 权限

- 群聊与私聊共用同一套权限
- 若私聊能下载，群聊理论上也应能下载（前提是消息能到达 groupHandler）

---

## 五、修复建议

### 5.1 方案 A：带附件的消息豁免 @ 门控（推荐）

在 `shouldSkipGroupMessage` 中，对带附件的消息不跳过：

```typescript
// 有附件（如图片）时，视为用户主动意图，不跳过
if (event.attachments && event.attachments.length > 0) {
  return false;
}
```

- 优点：纯图片、纯文件消息都能被处理

### 5.2 方案 B：仅图片豁免

```typescript
const hasImage = event.attachments?.some(a => a.type === 'image');
if (hasImage) return false;
```

- 优点：更保守，只处理图片
- 缺点：纯文件消息仍会被跳过

### 5.3 方案 C：配置开关

```typescript
// GROUP_ALLOW_ATTACHMENT_WITHOUT_MENTION=true 时，有附件的消息豁免 @ 门控
if (groupConfig.allowAttachmentWithoutMention && event.attachments?.length > 0) {
  return false;
}
```

- 优点：可配置，行为可控
- 缺点：多一个配置项

---

## 六、思考内容恶性重复 Bug（2024-03 补充）

### 6.1 现象

流式卡片中思考过程（reasoning）出现同一段内容重复 3–4 次，形成多个几乎相同的「思考过程」折叠面板。

### 6.2 根因

OpenCode 在 `messagePartUpdated` 中会推送多个 reasoning 片段，每个片段对应一个 part（如 `part.id`）。当模型在推理中陷入循环或重复时，会生成多个不同 part 但内容相同或高度相似的 reasoning 片段。桥接端按 part 为每个 segment 创建独立 timeline 段，导致多个 reasoning 段内容相同，最终在卡片中渲染成多个重复的折叠面板。

### 6.3 修复

在 `buildTimelineElements` 中增加 reasoning 去重逻辑：

- 新增 `isReasoningDuplicate(prev, curr)`：判断两段 reasoning 是否实质重复（完全相同，或一方为另一方子串且重叠超过 80%）
- 遍历 reasoning 段时，若当前段与上一段重复则跳过，避免重复展示

---

## 七、总结

| 项目 | 结论 |
|------|------|
| **根因** | `GROUP_REQUIRE_MENTION=true` 时，纯图片消息因无 @ 被 `shouldSkipGroupMessage` 跳过，从未进入 groupHandler |
| **私聊正常** | 私聊不经过 `shouldSkipGroupMessage`，直接进入处理流程 |
| **修复建议** | 在 `shouldSkipGroupMessage` 中，对带附件的消息返回 `false`（不跳过） |
