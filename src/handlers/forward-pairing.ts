// 转发配对协调器（forward-pairing-wait）
//
// 解决「转发体 + @提问」两条独立飞书消息被拆成两个 prompt、撞进同一张卡的问题：
// 用户转发 merge_forward（事件先到，但要 await 拉子消息，慢）并紧跟一句 @提问
// （事件后到，同步解析，先跑完）。若不协调，文字 prompt 先发（无转发正文 → "没看到"），
// 转发体后发第二个 prompt（被卡片 cleanup 截断）。
//
// 机制（依赖单线程 JS「函数运行到下一个 await 前不被抢占」）：
//   1. client 层检测到 merge_forward 的同步时刻、拉取前调 begin() 插旗；
//   2. 后到但更快的文字消息在 group 层 consume()，await 转发拼好后合并成一个 prompt；
//   3. 转发体自身的处理走 waitToBeConsumed()，被配对则静默，否则独立处理。
//
// 这是叶子模块：不 import client/group，避免循环依赖（flow 是 client → emit → router → handler）。

// 孤儿 state 兜底回收：非 owner 转发会被 router 挡掉、或有 pending question 提前 return，
// 都可能让 state 不被 consume/wait 回收。TTL sweep 防泄漏。
const STATE_TTL_MS = 60 * 1000;

type PairState = {
  senderId: string;
  ready: Promise<string>; // resolve 成 forwardText（拉取失败为 ''）
  resolveReady: (text: string) => void;
  consumed: boolean;
  consumedSignal: Promise<void>; // consume 提交时同步 resolve，供 waitToBeConsumed 竞速
  resolveConsumed: () => void;
  createdAt: number;
};

class ForwardPairingCoordinator {
  private states = new Map<string, PairState>(); // key: chatId

  // 检测到 merge_forward 时同步插旗。
  // 【约束】必须在 client.ts 拉子消息的 await 之前同步调用，否则后到的文字消息
  // 会先跑完而看不到旗标，配对失效。
  begin(chatId: string, senderId: string): void {
    this.sweep();
    // 同一 chat 已有挂起转发（罕见：连发两条转发）→ 旧的作废，避免泄漏/错配。
    const existing = this.states.get(chatId);
    if (existing) {
      existing.resolveReady('');
      existing.resolveConsumed();
    }

    let resolveReady!: (text: string) => void;
    const ready = new Promise<string>(resolve => {
      resolveReady = resolve;
    });
    let resolveConsumed!: () => void;
    const consumedSignal = new Promise<void>(resolve => {
      resolveConsumed = resolve;
    });

    this.states.set(chatId, {
      senderId,
      ready,
      resolveReady,
      consumed: false,
      consumedSignal,
      resolveConsumed,
      createdAt: Date.now(),
    });
  }

  // 拉子消息完成后调用，把转发正文交给等待中的 consume。
  ready(chatId: string, forwardText: string): void {
    const state = this.states.get(chatId);
    if (state) {
      state.resolveReady(forwardText);
    }
  }

  // 合格文字消息调用：若同一 chat 有同发送者的挂起转发，等它拼好并返回正文（供合并 prompt）。
  // 无挂起转发 / 不同发送者 → 同步返回 null（零额外延迟，覆盖绝大多数普通消息）。
  async consume(chatId: string, senderId: string, timeoutMs = 3000): Promise<string | null> {
    const state = this.states.get(chatId);
    if (!state) return null;
    // 同发送者守卫：群里 owner 转发、他人 @bot 不应被错误归并。
    if (state.senderId && senderId && state.senderId !== senderId) return null;

    const timeout = new Promise<null>(resolve => {
      setTimeout(() => resolve(null), timeoutMs);
    });
    const forwardText = await Promise.race([state.ready, timeout]);

    // 决定使用 forward：同步置 consumed 并 resolve 信号，中间不 await（防双 fire 竞态）。
    state.consumed = true;
    state.resolveConsumed();
    this.states.delete(chatId);

    if (forwardText === null) return null; // 超时没等到（转发拉取异常慢）→ 文字独立处理
    return forwardText; // 含 ''（拉取失败）：调用方按空串处理，仍算已配对
  }

  // 转发体自身处理时调用：等窗口内是否被配对文字 consume。
  // 返回 true=被配对（应静默，避免重复回复）；false=无人配对（应独立处理）。
  // 不轮询：await consumedSignal 与 timeout 竞速，超时后再同步复查一次。
  async waitToBeConsumed(chatId: string, windowMs = 2000): Promise<boolean> {
    const state = this.states.get(chatId);
    if (!state) return false;

    const timeout = new Promise<void>(resolve => {
      setTimeout(() => resolve(), windowMs);
    });
    await Promise.race([state.consumedSignal, timeout]);

    // 同步复查：单线程下此刻读取 consumed 是权威的，无人能在 await 之间翻转它。
    const consumed = state.consumed;
    if (!consumed) {
      this.states.delete(chatId); // 无人配对，转发独立处理，清理自身 state
    }
    return consumed;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [chatId, state] of this.states) {
      if (now - state.createdAt > STATE_TTL_MS) {
        state.resolveReady('');
        state.resolveConsumed();
        this.states.delete(chatId);
      }
    }
  }
}

export const forwardPairing = new ForwardPairingCoordinator();
