import { describe, it, expect } from 'vitest';
import { forwardPairing } from '../src/handlers/forward-pairing.js';

// 协调器是单例；各用例用不同 chatId 隔离，互不干扰。
const A = 'sender-A';
const B = 'sender-B';

describe('ForwardPairingCoordinator', () => {
  it('begin→ready→consume 返回 forwardText 并配对，waitToBeConsumed 抑制转发', async () => {
    const chat = 'c1';
    forwardPairing.begin(chat, A);
    forwardPairing.ready(chat, '【转发消息】hello');

    const consumed = await forwardPairing.consume(chat, A);
    expect(consumed).toBe('【转发消息】hello');

    // consume 后 state 已删，转发体 wait 立刻得知被消费（抑制）。
    const suppressed = await forwardPairing.waitToBeConsumed(chat, 50);
    expect(suppressed).toBe(false); // state 已不存在 → 当作无人配对（转发体早已被合并，不会再来）
  });

  it('双 fire 竞态：并发 consume + waitToBeConsumed，ready 后只配对一次、转发被抑制', async () => {
    const chat = 'c2';
    forwardPairing.begin(chat, A);

    const consumeP = forwardPairing.consume(chat, A, 500);
    const waitP = forwardPairing.waitToBeConsumed(chat, 500);
    // 转发拉取稍后完成
    setTimeout(() => forwardPairing.ready(chat, 'body'), 10);

    const [consumed, suppressed] = await Promise.all([consumeP, waitP]);
    expect(consumed).toBe('body');   // 文字拿到正文，发合并 prompt
    expect(suppressed).toBe(true);   // 转发体被抑制，不独立 fire
  });

  it('超时：begin 后无人 consume → waitToBeConsumed 窗口后返回 false（转发独立处理）', async () => {
    const chat = 'c3';
    forwardPairing.begin(chat, A);
    forwardPairing.ready(chat, 'body');

    const suppressed = await forwardPairing.waitToBeConsumed(chat, 30);
    expect(suppressed).toBe(false);
  });

  it('拉取失败 ready("")：文字 consume 得空串（已配对），转发被抑制 → 净一条回复', async () => {
    const chat = 'c4';
    forwardPairing.begin(chat, A);

    const consumeP = forwardPairing.consume(chat, A, 500);
    const waitP = forwardPairing.waitToBeConsumed(chat, 500);
    setTimeout(() => forwardPairing.ready(chat, ''), 10);

    const [consumed, suppressed] = await Promise.all([consumeP, waitP]);
    expect(consumed).toBe('');     // 空串：调用方按"已配对但无正文"处理
    expect(suppressed).toBe(true); // 转发体仍被抑制
  });

  it('不同发送者：begin(A) + consume(B) → null（不配对），转发体独立处理', async () => {
    const chat = 'c5';
    forwardPairing.begin(chat, A);
    forwardPairing.ready(chat, 'body');

    const consumed = await forwardPairing.consume(chat, B);
    expect(consumed).toBe(null); // B 的文字不与 A 的转发配对

    // state 未被 B 消费 → 转发体 wait 超时后独立处理。
    const suppressed = await forwardPairing.waitToBeConsumed(chat, 30);
    expect(suppressed).toBe(false);
  });

  it('无挂起转发：consume 同步返回 null（零额外延迟）', async () => {
    const consumed = await forwardPairing.consume('c6-never-begun', A);
    expect(consumed).toBe(null);
  });

  it('双转发：begin 两次 → 旧 state 作废，第二次正常配对', async () => {
    const chat = 'c7';
    forwardPairing.begin(chat, A);
    forwardPairing.ready(chat, 'first');
    // 第二条转发覆盖（旧的被 resolve 作废，不泄漏）
    forwardPairing.begin(chat, A);
    forwardPairing.ready(chat, 'second');

    const consumed = await forwardPairing.consume(chat, A);
    expect(consumed).toBe('second');
  });
});
