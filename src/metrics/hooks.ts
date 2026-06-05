import { metrics } from './collector.js';

export type MessageDirection = 'incoming' | 'outgoing';

export function startMessageTimer(): () => void {
  const start = Date.now();
  return () => {
    metrics.recordMessageE2E(Date.now() - start);
  };
}

export function startDeliveryTimer(): () => void {
  const start = Date.now();
  return () => {
    metrics.recordFeishuApiDelivery(Date.now() - start);
  };
}

export function recordFeishuApi(success: boolean): void {
  metrics.recordFeishuApiCall(success);
}

export function recordOpencodeApi(success: boolean): void {
  metrics.recordOpencodeApiCall(success);
}

export function recordQuestionOutcome(outcome: 'answered' | 'skipped' | 'timedOut' | 'rejected'): void {
  metrics.recordQuestionOutcome(outcome);
}

export function recordMessageLost(): void {
  metrics.recordMessageLost();
}

export function recordEventStreamReconnect(): void {
  metrics.recordEventStreamReconnect();
}

export function recordEventStreamMessage(): void {
  metrics.recordEventStreamMessage();
}
