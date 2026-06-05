// 轻量级性能指标采集器
// 设计原则：同步无 I/O、最小侵入、零依赖

// ─── L1 黄金指标（用户感知） ───────────────────────────────

/** 消息端到端延迟分桶 */
interface LatencyBucket {
  count: number;
  totalMs: number;
  maxMs: number;
}

/** Question 处理分桶 */
interface QuestionBucket {
  answered: number;    // 用户回答
  skipped: number;     // 用户跳过
  timedOut: number;    // 超时自动回复
  rejected: number;    // 被拒绝
}

// ─── L2 内部指标 ─────────────────────────────────────────

/** 飞书 API 调用计数 */
interface ApiCallBucket {
  success: number;
  failure: number;
}

/** 事件流健康度 */
interface EventStreamHealth {
  reconnects: number;
  messagesReceived: number;
}

// ─── 聚合快照 ─────────────────────────────────────────────

export interface MetricsSnapshot {
  // L1 黄金指标
  messageE2E: LatencyBucket;
  feishuApiDelivery: LatencyBucket;
  messageLost: number;
  questionOutcome: QuestionBucket;

  // L2 内部指标
  feishuApiCalls: ApiCallBucket;
  opencodeApiCalls: ApiCallBucket;
  eventStream: EventStreamHealth;
  activeBuffers: number;

  // 元信息
  uptimeMs: number;
  collectedAt: string;
}

class MetricsCollector {
  private startTime = Date.now();

  // L1
  private messageE2E: LatencyBucket = { count: 0, totalMs: 0, maxMs: 0 };
  private feishuApiDelivery: LatencyBucket = { count: 0, totalMs: 0, maxMs: 0 };
  private messageLost = 0;
  private questionOutcome: QuestionBucket = { answered: 0, skipped: 0, timedOut: 0, rejected: 0 };

  // L2
  private feishuApiCalls: ApiCallBucket = { success: 0, failure: 0 };
  private opencodeApiCalls: ApiCallBucket = { success: 0, failure: 0 };
  private eventStream: EventStreamHealth = { reconnects: 0, messagesReceived: 0 };
  private activeBuffers = 0;

  // 定时输出句柄
  private reportTimer: NodeJS.Timeout | null = null;

  // ─── 记录方法（同步，供埋点调用） ──────────────────────

  /** 记录消息端到端延迟 */
  recordMessageE2E(durationMs: number): void {
    this.messageE2E.count += 1;
    this.messageE2E.totalMs += durationMs;
    if (durationMs > this.messageE2E.maxMs) {
      this.messageE2E.maxMs = durationMs;
    }
  }

  /** 记录飞书 API 投递延迟 */
  recordFeishuApiDelivery(durationMs: number): void {
    this.feishuApiDelivery.count += 1;
    this.feishuApiDelivery.totalMs += durationMs;
    if (durationMs > this.feishuApiDelivery.maxMs) {
      this.feishuApiDelivery.maxMs = durationMs;
    }
  }

  /** 记录消息丢失 */
  recordMessageLost(): void {
    this.messageLost += 1;
  }

  /** 记录 Question 处理结果 */
  recordQuestionOutcome(outcome: keyof QuestionBucket): void {
    this.questionOutcome[outcome] += 1;
  }

  /** 记录飞书 API 调用结果 */
  recordFeishuApiCall(success: boolean): void {
    if (success) {
      this.feishuApiCalls.success += 1;
    } else {
      this.feishuApiCalls.failure += 1;
    }
  }

  /** 记录 OpenCode API 调用结果 */
  recordOpencodeApiCall(success: boolean): void {
    if (success) {
      this.opencodeApiCalls.success += 1;
    } else {
      this.opencodeApiCalls.failure += 1;
    }
  }

  /** 记录事件流重连 */
  recordEventStreamReconnect(): void {
    this.eventStream.reconnects += 1;
  }

  /** 记录事件流收到消息 */
  recordEventStreamMessage(): void {
    this.eventStream.messagesReceived += 1;
  }

  /** 更新活跃缓冲区数量 */
  setActiveBuffers(count: number): void {
    this.activeBuffers = count;
  }

  // ─── 快照与输出 ─────────────────────────────────────

  /** 生成当前指标快照（不重置） */
  snapshot(): MetricsSnapshot {
    return {
      messageE2E: { ...this.messageE2E },
      feishuApiDelivery: { ...this.feishuApiDelivery },
      messageLost: this.messageLost,
      questionOutcome: { ...this.questionOutcome },
      feishuApiCalls: { ...this.feishuApiCalls },
      opencodeApiCalls: { ...this.opencodeApiCalls },
      eventStream: { ...this.eventStream },
      activeBuffers: this.activeBuffers,
      uptimeMs: Date.now() - this.startTime,
      collectedAt: new Date().toISOString(),
    };
  }

  /** 生成当前指标快照并重置计数器（用于周期性报告） */
  snapshotAndReset(): MetricsSnapshot {
    const snap = this.snapshot();

    // 重置 L1
    this.messageE2E = { count: 0, totalMs: 0, maxMs: 0 };
    this.feishuApiDelivery = { count: 0, totalMs: 0, maxMs: 0 };
    this.messageLost = 0;
    this.questionOutcome = { answered: 0, skipped: 0, timedOut: 0, rejected: 0 };

    // 重置 L2（保留 activeBuffers，它是瞬时值）
    this.feishuApiCalls = { success: 0, failure: 0 };
    this.opencodeApiCalls = { success: 0, failure: 0 };
    this.eventStream = { reconnects: 0, messagesReceived: 0 };

    return snap;
  }

  /** 格式化快照为单行日志 */
  formatLogLine(snap: MetricsSnapshot): string {
    const avgE2E = snap.messageE2E.count > 0
      ? Math.round(snap.messageE2E.totalMs / snap.messageE2E.count)
      : 0;
    const avgDelivery = snap.feishuApiDelivery.count > 0
      ? Math.round(snap.feishuApiDelivery.totalMs / snap.feishuApiDelivery.count)
      : 0;

    const feishuTotal = snap.feishuApiCalls.success + snap.feishuApiCalls.failure;
    const feishuRate = feishuTotal > 0
      ? Math.round((snap.feishuApiCalls.success / feishuTotal) * 100)
      : 100;

    const ocTotal = snap.opencodeApiCalls.success + snap.opencodeApiCalls.failure;
    const ocRate = ocTotal > 0
      ? Math.round((snap.opencodeApiCalls.success / ocTotal) * 100)
      : 100;

    const qTotal = snap.questionOutcome.answered + snap.questionOutcome.skipped
      + snap.questionOutcome.timedOut + snap.questionOutcome.rejected;

    const parts = [
      `e2e=${snap.messageE2E.count}req/${avgE2E}ms-avg/${snap.messageE2E.maxMs}ms-max`,
      `delivery=${snap.feishuApiDelivery.count}req/${avgDelivery}ms-avg`,
      `lost=${snap.messageLost}`,
      `question=${qTotal}(ok=${snap.questionOutcome.answered}/skip=${snap.questionOutcome.skipped}/timeout=${snap.questionOutcome.timedOut}/reject=${snap.questionOutcome.rejected})`,
      `feishu-api=${feishuTotal}req/${feishuRate}%ok`,
      `oc-api=${ocTotal}req/${ocRate}%ok`,
      `sse-reconnects=${snap.eventStream.reconnects}`,
      `sse-msgs=${snap.eventStream.messagesReceived}`,
      `buffers=${snap.activeBuffers}`,
      `uptime=${Math.round(snap.uptimeMs / 1000)}s`,
    ];

    return `[Metrics] ${parts.join(' | ')}`;
  }

  // ─── 生命周期 ───────────────────────────────────────

  /** 启动定时报告（默认 5 分钟） */
  startPeriodicReport(intervalMs = 5 * 60 * 1000): void {
    this.stopPeriodicReport();
    this.reportTimer = setInterval(() => {
      const snap = this.snapshotAndReset();
      console.log(this.formatLogLine(snap));
    }, intervalMs);

    // 允许进程正常退出
    if (this.reportTimer.unref) {
      this.reportTimer.unref();
    }
  }

  /** 停止定时报告 */
  stopPeriodicReport(): void {
    if (this.reportTimer) {
      clearInterval(this.reportTimer);
      this.reportTimer = null;
    }
  }

  /** 输出最终报告并停止 */
  shutdown(): void {
    const snap = this.snapshotAndReset();
    console.log(`${this.formatLogLine(snap)} [SHUTDOWN]`);
    this.stopPeriodicReport();
  }
}

// 单例导出
export const metrics = new MetricsCollector();
