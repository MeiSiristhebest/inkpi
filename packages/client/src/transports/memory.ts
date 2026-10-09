import type { RpcTransport } from '../types.js';

/**
 * 纯内存对称传输层 (MemoryTransport)
 * 用于进程内直连、单元测试与免端口绑定的微服务代理。
 */
export class MemoryTransport implements RpcTransport {
  private peer?: MemoryTransport;
  private handlers: ((message: string) => void)[] = [];
  private closeHandlers: ((error?: Error) => void)[] = [];
  private open = true;

  public static createPair(): [MemoryTransport, MemoryTransport] {
    const a = new MemoryTransport();
    const b = new MemoryTransport();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  public send(message: string): void {
    if (!this.open || !this.peer) return;
    queueMicrotask(() => {
      if (this.peer?.open) {
        for (const handler of this.peer.handlers) {
          handler(message);
        }
      }
    });
  }

  public onMessage(handler: (message: string) => void): void {
    this.handlers.push(handler);
  }

  public onClose(handler: (error?: Error) => void): void {
    if (!this.open) {
      handler(new Error('RPC memory connection is closed'));
      return;
    }
    this.closeHandlers.push(handler);
  }

  public close(): void {
    const error = new Error('RPC memory connection closed');
    this.markClosed(error);
    this.peer?.markClosed(error);
  }

  public isOpen(): boolean {
    return this.open;
  }

  private markClosed(error: Error): void {
    if (!this.open) return;
    this.open = false;
    for (const handler of this.closeHandlers) handler(error);
    this.closeHandlers = [];
  }
}
