import { outputConfig } from '../config.js';

// 输出缓冲区（用于聚合输出后定时发送）
interface BufferedOutput {
  key: string;
  chatId: string;
  messageId: string | null;
  thinkingMessageId: string | null;
  replyMessageId: string | null;
  sessionId: string;
  content: string[];
  thinking: string[];
  tools: Array<{
    name: string;
    status: 'pending' | 'running' | 'completed' | 'failed';
    output?: string;
  }>;
  finalText: string;
  finalThinking: string;
  openCodeMsgId: string;
  showThinking: boolean;
  dirty: boolean;
  lastUpdate: number;
  createdAt: number;
  timer: NodeJS.Timeout | null;
  status: 'running' | 'completed' | 'failed' | 'aborted';
  isUpdating: boolean;
  cancelled: boolean;
}

class OutputBuffer {
  private buffers: Map<string, BufferedOutput> = new Map();
  private updateCallback: ((buffer: BufferedOutput) => Promise<void>) | null = null;
  private clearCallback: ((key: string) => void) | null = null;

  setUpdateCallback(callback: (buffer: BufferedOutput) => Promise<void>): void {
    this.updateCallback = callback;
  }

  setClearCallback(callback: (key: string) => void): void {
    this.clearCallback = callback;
  }

  // 创建或获取缓冲区
  getOrCreate(key: string, chatId: string, sessionId: string, replyMessageId: string | null, caller = 'unknown'): BufferedOutput {
    let buffer = this.buffers.get(key);

    if (!buffer) {
      const err = { stack: '' };
      Error.captureStackTrace(err);
      const stack = err.stack.split('\n').slice(1, 20).join('\n  ');
      console.log(`[Buffer] getOrCreate NEW key=${key} caller=${caller}\n  ${stack}`);
      buffer = {
        key,
        chatId,
        messageId: null,
        thinkingMessageId: null,
        replyMessageId,
        sessionId,
        content: [],
        thinking: [],
        tools: [],
        finalText: '',
        finalThinking: '',
        openCodeMsgId: '',
        showThinking: false,
        dirty: false,
        lastUpdate: Date.now(),
        createdAt: Date.now(),
        timer: null,
        status: 'running',
        isUpdating: false,
        cancelled: false,
      };
      this.buffers.set(key, buffer);
    }

    return buffer;
  }

  // 追加内容
  append(key: string, text: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;

    buffer.content.push(text);
    buffer.dirty = true;
    this.scheduleUpdate(key);
  }

  // 追加思考内容
  appendThinking(key: string, text: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;

    buffer.thinking.push(text);
    buffer.dirty = true;
    this.scheduleUpdate(key);
  }

  // 设置正文卡片消息ID
  setMessageId(key: string, messageId: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.messageId = messageId;
    }
  }

  // 设置用户消息ID（用于 reaction 等，需在 ensureStreamingBuffer 时写入）
  setReplyMessageId(key: string, replyMessageId: string | null): void {
    const buffer = this.buffers.get(key);
    if (buffer && replyMessageId) {
      buffer.replyMessageId = replyMessageId;
    }
  }

  // 设置思考卡片消息ID
  setThinkingMessageId(key: string, messageId: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.thinkingMessageId = messageId;
    }
  }

  // 设置工具状态快照
  setTools(
    key: string,
    tools: Array<{ name: string; status: 'pending' | 'running' | 'completed' | 'failed'; output?: string }>
  ): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.tools = [...tools];
      buffer.dirty = true;
      this.scheduleUpdate(key);
    }
  }

  touch(key: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    buffer.dirty = true;
    this.scheduleUpdate(key);
  }

  // 设置最终文本和思考快照
  setFinalSnapshot(key: string, text: string, thinking: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.finalText = text;
      buffer.finalThinking = thinking;
    }
  }

  // 设置 OpenCode 消息ID
  setOpenCodeMsgId(key: string, openCodeMsgId: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.openCodeMsgId = openCodeMsgId;
    }
  }

  // 设置思考展开状态
  setShowThinking(key: string, showThinking: boolean): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      buffer.showThinking = showThinking;
    }
  }

  // 设置状态
  // forceOverride: 当为 true 时，允许将 failed 覆盖为 completed（用于 session.idle 纠正误报的 session.error）
  setStatus(key: string, status: BufferedOutput['status'], forceOverride = false): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    if (buffer.status === status) {
      if (buffer.dirty) this.triggerUpdate(key);
      return;
    }
    if (!forceOverride && buffer.status !== 'running') return;
    buffer.status = status;
    buffer.dirty = true;
    this.triggerUpdate(key);
  }

  // 调度更新
  private scheduleUpdate(key: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.timer) return;

    buffer.timer = setTimeout(() => {
      this.triggerUpdate(key);
    }, outputConfig.updateInterval);
  }

  // 触发更新
  private async triggerUpdate(key: string): Promise<void> {
    const buffer = this.buffers.get(key);
    if (!buffer) return;

    if (buffer.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }

    buffer.lastUpdate = Date.now();

    const shouldUpdate = buffer.dirty || buffer.status !== 'running';

    if (this.updateCallback && shouldUpdate) {
      if (buffer.isUpdating) {
        buffer.dirty = true;
        return;
      }
      if (buffer.cancelled) return;
      buffer.dirty = false;
      buffer.isUpdating = true;
      try {
        await this.updateCallback(buffer);
      } catch (error) {
        buffer.dirty = true;
        throw error;
      } finally {
        buffer.isUpdating = false;
        if (buffer.cancelled) return;
        const currentBuffer = this.buffers.get(key);
        if (currentBuffer?.dirty) {
          void this.triggerUpdate(key);
        }
      }
    }
  }

  markDirty(key: string): void {
    const buffer = this.buffers.get(key);
    if (!buffer) return;
    buffer.dirty = true;
    if (!buffer.isUpdating) {
      void this.triggerUpdate(key);
    }
  }

  // 获取并清空内容
  getAndClear(key: string): { text: string; thinking: string } {
    const buffer = this.buffers.get(key);
    if (!buffer) return { text: '', thinking: '' };

    const text = buffer.content.join('');
    buffer.content = [];
    
    const thinking = buffer.thinking.join('');
    buffer.thinking = [];
    
    return { text, thinking };
  }


  clear(key: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
      }
      buffer.cancelled = true;
      this.buffers.delete(key);
      this.clearCallback?.(key);
    }
  }

  // 获取缓冲区
  get(key: string): BufferedOutput | undefined {
    return this.buffers.get(key);
  }

  // 中断输出
  abort(key: string): void {
    const buffer = this.buffers.get(key);
    if (buffer) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
      buffer.status = 'aborted';
      // 触发最后一次更新
      this.triggerUpdate(key);
      // 清理缓冲区
      this.clear(key);
    }
  }

  abortAll(): void {
    const keys = Array.from(this.buffers.keys());
    for (const key of keys) {
      const buffer = this.buffers.get(key);
      if (buffer && buffer.status === 'running') {
        this.abort(key);
      }
    }
  }

  getChatIdBySessionId(sessionId: string): string | undefined {
    for (const buffer of this.buffers.values()) {
      if (buffer.sessionId === sessionId) {
        return buffer.chatId;
      }
    }
    return undefined;
  }

  // 清理所有缓冲区和定时器
  clearAll(): void {
    for (const buffer of this.buffers.values()) {
      if (buffer.timer) {
        clearTimeout(buffer.timer);
        buffer.timer = null;
      }
    }
    this.buffers.clear();
  }
}

// 单例导出
export const outputBuffer = new OutputBuffer();
