import { type RpcLimits, RpcSendWindow } from './rpc-limits.js';

/** WebSocket send completion follows the host's bufferedAmount, with a bounded wait. */
export class RpcBufferedSender {
  private readonly window: RpcSendWindow;
  private readonly pending = new Set<{ release: () => void; resolve: () => void; reject: (error: Error) => void }>();
  private timer?: ReturnType<typeof setTimeout>;
  private deadline?: number;
  private closedError?: Error;
  constructor(
    private readonly limits: RpcLimits,
    private readonly bufferedAmount: () => number,
    private readonly sendMessage: (message: string) => void,
    private readonly fail: (error: Error) => void
  ) {
    this.window = new RpcSendWindow(limits);
  }
  send(message: string): Promise<void> {
    if (this.closedError) return Promise.reject(this.closedError);
    let release: () => void;
    try {
      release = this.window.reserve(message, this.bufferedAmount());
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('RPC send failed');
      this.fail(failure);
      return Promise.reject(failure);
    }
    try {
      this.sendMessage(message);
    } catch (error) {
      release();
      return Promise.reject(error);
    }
    if (this.bufferedAmount() === 0) {
      release();
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.pending.add({ release, resolve, reject });
      this.deadline ??= performance.now() + this.limits.requestTimeoutMs;
      if (!this.timer) this.timer = setTimeout(() => this.poll(), 10);
    });
  }
  close(error: Error): void {
    this.closedError ??= error;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.deadline = undefined;
    for (const pending of this.pending) {
      pending.release();
      pending.reject(error);
    }
    this.pending.clear();
  }
  private poll(): void {
    this.timer = undefined;
    if (this.closedError) return;
    if (this.bufferedAmount() === 0) {
      for (const pending of this.pending) {
        pending.release();
        pending.resolve();
      }
      this.pending.clear();
      this.deadline = undefined;
    } else if (performance.now() >= (this.deadline ?? 0)) this.fail(new Error('RPC WebSocket send timed out'));
    else this.timer = setTimeout(() => this.poll(), 10);
  }
}
