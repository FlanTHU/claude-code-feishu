# 在 Claude Code 侧复用 feishu-opencode-bridge — 调研报告

**项目路径**: `~/.config/opencode/feishu-opencode-bridge/`
**调研日期**: 2026-06-04
**目标形态**: 可切换共存 / 复用现有飞书 bot / 本文为调研结论（暂不落代码）

---

## 一、结论先行

**可行,但不是"复用来连接",而是"加一个 Claude Code 后端适配器"。** 飞书 bot 那一侧(凭据、连接、卡片、交互)100% 不用动;真正要写的是一个跟 `opencodeClient` 平级的 `claudeClient`。

核心判断:**平台层抽象得很干净,后端层完全没抽象**。这决定了改造形态——必须先补一个后端抽象层,才能让 opencode 和 claude code 可切换共存。

---

## 二、架构现状(已实测)

```
飞书/Discord ──[PlatformAdapter ✅已抽象]──> 路由·会话·卡片流·权限UI ──[opencodeClient ❌死绑]──> opencode serve (HTTP :4096)
   平台层:可插拔                                   业务层:价值所在                        后端层:无接口,单例直引
```

**后端耦合分布**(grep 实测):11 个文件 import `opencode/client`,共调用 `opencodeClient.*` 约 98 次。分布极不均匀:

| 文件 | 调用数 | 性质 |
|---|---|---|
| `handlers/command.ts` | **32** | ⚠️ 命令面板,深度绑定 opencode 专有概念 |
| `handlers/discord.ts` | 33 | Discord 专用,可忽略 |
| `router/opencode-event-hub.ts` | 9 | ⚠️ 事件中枢,监听 8 类 opencode 事件 |
| `handlers/p2p.ts` / `group.ts` | 各 7 | 收发消息主链路 |
| `index.ts` | 4 | 仅 connect/disconnect/status/permission |

好消息:**主链路(p2p/group/index)耦合很浅**;坏消息:**command.ts 和 event-hub 是重灾区**。

---

## 三、后端契约(claudeClient 要实现什么)

`opencodeClient` 是个 `EventEmitter`,对外契约两部分:

**① 出站方法**(被调用):
- 核心:`connect` / `sendMessageAsync` / `sendMessagePartsAsync` / `abortSession` / `respondToPermission` / `getConnectionStatus`
- 会话管理:`createSession` / `getSessionById` / `getSessionMessages` / `deleteSession` / `updateSession` / `revertMessage` / `summarizeSession`
- opencode 专有:`getProviders` / `getAgents` / `getConfig` / `updateConfig` / `listProjects` / `listSessionsAcrossProjects` / `findSessionAcrossProjects`

**② 出站事件**(被 event-hub 监听):
`permissionRequest` / `messagePartUpdated` / `messageUpdated` / `sessionUpdated` / `sessionStatus` / `sessionIdle` / `sessionError` / `questionAsked`

流式模型是 **fire-and-forget**:`sendMessageAsync` 立即返回(POST `/session/:id/prompt_async`),内容全靠 `messagePartUpdated` 事件推到卡片流。这套设计对 Claude Agent SDK 其实很友好。

---

## 四、推荐路线:Claude Agent SDK

用 `@anthropic-ai/claude-agent-sdk`(TS) 写 `src/claude/client.ts`,实现上面的契约。SDK 的 `query()` 返回流式 async iterator,事件能较好映射:

| opencode 事件/方法 | Claude Agent SDK 对应 | 映射难度 |
|---|---|---|
| `messagePartUpdated`(文本/思考/工具流) | `query()` yield 的 assistant message + tool_use block 流 | 🟢 直接映射 |
| `sessionIdle` | `result` 消息 | 🟢 |
| `sessionError` | result 中的 error | 🟢 |
| `sendMessageAsync` | `query({ prompt, options })` | 🟢 |
| `abortSession` | AbortController | 🟢 |
| 会话续接 | `resume` / `resumeSessionId` | 🟡 语义不同 |
| `permissionRequest` + `respondToPermission` | `canUseTool` 回调 | 🔴 模型不同,见硬骨头① |
| `questionAsked` | 无原生对应 | 🔴 见硬骨头② |
| `getProviders/getAgents/getConfig/listProjects` | **无对应** | 🔴 见硬骨头③ |

备选路线 B(包 `claude` CLI,spawn `--output-format stream-json`)流式解析与权限映射都更费劲,不推荐。

---

## 五、三个绕不开的硬骨头

**① 权限模型是反的。** opencode 是**异步事件**(emit `permissionRequest` → 用户点飞书卡片 → 调 `respondToPermission` 回事);Claude Agent SDK 是**同步回调** `canUseTool(tool, input) => Promise<{behavior:'allow'|'deny'}>`。适配方法:在 `canUseTool` 里 emit `permissionRequest` 并**挂起一个 Promise**(把 resolve 存进 Map,以 permissionId 为 key),等飞书卡片回调时取出 resolve。可行,但这是适配器里最 tricky 的一段,要处理超时/会话中止时的 Promise 泄漏。

**② `questionAsked`(AI 反问用户)没有原生对应。** opencode 有让 AI 主动反问、用户在飞书卡片上选答案的机制。Claude Code 侧需要靠工具(如自定义 AskUserQuestion 工具或 hook)模拟,否则这个交互能力会丢失。可降级(先不支持),但属功能缺口,需拍板。

**③ session/project 概念对不上 —— command.ts 半数命令会"降级"。** opencode 有服务端的跨 project 会话持久化、列表、`revertMessage`、`summarizeSession`、`getProviders/getAgents`。Claude Agent SDK **没有服务端 session 列表 API**,只有 `resume <id>` 续接单个会话,也没有 providers/agents/projects 概念。后果:
- `/sessions` 列表、跨 project 查找、revert、summarize → 要么**自建本地 session 索引**(存 json,类似现有 `.chat-sessions.json`),要么这些命令在 claude 后端下**返回"不支持"**。
- `getProviders/getAgents/getConfig` → claude 后端返回固定/空集合。
- 模型切换:从 opencode 的 provider/model 二元组,改成 Claude 的 model 字符串。

---

## 六、改造方案(可切换共存)

因为要共存,**必须先补一个后端抽象层**(平台层有 `PlatformAdapter`,后端层照抄):

1. **新建 `src/backend/types.ts`** —— 定义 `AiBackend` 接口,把"出站方法+出站事件"固化成契约(EventEmitter 子类)。
2. **`opencodeClient` 实现 `AiBackend`** —— 现有代码加个 `implements`,基本不改逻辑。
3. **新建 `src/claude/client.ts`** —— `claudeClient` 实现同一接口,内部用 Agent SDK。
4. **切换点** —— `config.ts` 加 `AI_BACKEND=opencode|claude`,`index.ts` 据此注入单例;`event-hub` 改成依赖接口而非具体单例。
5. **command.ts 分支降级** —— opencode 专有命令在 claude 后端下显式提示不支持或走本地索引。

**复用率**:平台层 + 卡片流 + 权限/问答 UI 框架 + 命令解析 + 会话目录管理 ≈ **复用 70%+**;新写的主要是 `claude/client.ts`(预估 400~700 行)+ 后端接口(~100 行)+ command.ts 降级分支。

**飞书凭据**:`.env` 现有 App ID/Secret 直接复用,同一个 bot;无需改飞书后台。

> ⚠️ **关键约束**:同一个 bot 不能同时被 opencode 实例和 claude 实例连(会抢消息)。所以"共存"指的是**配置切换、同一时间只跑一个后端**,不是同时双跑。若要真同时双跑,得新建第二个飞书应用。

---

## 七、Spike 实测结论(2026-06-04,已跑通)

在独立目录 `~/claude-sdk-spike/` 用 `@anthropic-ai/claude-agent-sdk@0.3.162` 实跑了 4 组递进实验,验证路线 A 成立性。**结论:成立,但权限机制必须改用 hook。**

### 鉴权(关键卡点,已打掉)

环境里现成的两个变量直接驱动 SDK,无需官方 key:
- `ANTHROPIC_API_KEY`(mify key,`mit-xs...`)
- `ANTHROPIC_BASE_URL=http://model.mify.ai.srv/anthropic`
- 模型 `ppio/pa/claude-opus-4-8` 正常工作(注:tool id 前缀 `toolu_bdrk_`,说明 mify 实际转发到 **Bedrock 后端**)

### 五项验证最终结果

| 项 | 结果 | 实证 |
|---|---|---|
| ① mify 网关驱动 SDK | ✅ | `system/init` 拿到 session_id |
| ② 流式增量文本 | ✅ | `stream_event` 的 `content_block_delta` 逐字符可收 |
| ③ tool_use 事件 | ✅ | assistant 消息含 `tool_use` 块 + id |
| ④ 权限拦截 | ✅ **仅 `PreToolUse` hook 可用** | 见下 |
| ⑤ result 终结事件 | ✅ | `subtype=success`,带 turns/cost |

### ⚠️ 重大发现:canUseTool 在 mify→Bedrock 链路下完全失效

实验对比(4 组):

| 机制 | 依赖通道 | 结果 |
|---|---|---|
| `canUseTool` 回调 | SDK 双向 control_request(`sdk.d.ts:3413`) | ❌ 完全不触发,工具被无条件执行 |
| `disallowedTools` | 同上 control 通道 | ⚠️ 也拦不住 |
| **`PreToolUse` hook** | 进程内本地回调 | ✅ **触发且成功拦截**(deny 后输出未泄漏) |

**根因**:`canUseTool` / `disallowedTools` 走 SDK 的双向 control 通道,该通道在 mify 网关转发链路下不通,导致权限层被静默绕过。`PreToolUse` hook 是进程内本地回调,不挑链路,可靠。

**安全提醒**:在 mify 网关链路上,`canUseTool` / `disallowedTools` 形同虚设。任何基于 Agent SDK 的权限控制必须用 **hook** 或 **`permissionMode`** 兜底,不能依赖前两者。

### 对方案的影响:权限接入点从 canUseTool 改为 PreToolUse hook

原"硬骨头①"实测有解,且 hook 比 canUseTool 更契合飞书卡片模式:

```
Claude 要用工具 → PreToolUse hook 触发(本地,可靠)
  → 发飞书权限卡片 + 挂起 Promise
  → 用户点「允许/拒绝」→ resolve
  → hook 返回 {decision: "approve"|"block", reason}
```

与 bridge 现有"emit 事件 → 飞书卡片 → 回调 resolve"模式一致。

### 仍待拍板

- 🟡 `questionAsked`(AI 反问)功能缺口:Agent SDK 无原生对应,可用 `AskUserQuestion` 工具模拟或先降级。

---

## 八、改造路线图(进行中)

阶段 0(已完成):可行性 spike + 鉴权验证 ✅

正式改造按依赖排序:
1. **补 `src/backend/types.ts`** —— 定义 `AiBackend` 接口(出站方法 + 出站事件,EventEmitter 子类)。
2. **`opencodeClient implements AiBackend`** —— 现有代码加约束,逻辑不动。
3. **写 `src/claude/client.ts`** —— 实现 `AiBackend`,内部用 Agent SDK;权限走 `PreToolUse` hook。
4. **切换点** —— `config.ts` 加 `AI_BACKEND=opencode|claude`,`index.ts` 据此注入;`event-hub` 依赖接口而非具体单例。
5. **command.ts 降级** —— opencode 专有命令(providers/agents/跨 project session)在 claude 后端下走本地索引或提示不支持。
