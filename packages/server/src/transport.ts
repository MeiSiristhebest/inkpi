/**
 * 通用 RPC 传输层抽象
 */

/**
 * RPC 监听/连接的默认主机。仅回环地址——守护进程默认不暴露到外部网卡。
 * 需要对外暴露时必须在调用点显式传入 host（安全默认，而非散落的字面量）。
 */
import { DEFAULT_RPC_HOST, DEFAULT_RPC_PORT } from '@inkpi/protocol';

export { DEFAULT_RPC_HOST, DEFAULT_RPC_PORT } from '@inkpi/protocol';

export interface RpcTransport {
  send(message: string): Promise<void> | void;
  onMessage(handler: (message: string) => void): void;
  /** Notifies pending RPC calls when the underlying connection closes. */
  onClose?(handler: (error?: Error) => void): void;
  close(): Promise<void> | void;
  isOpen(): boolean;
}

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
