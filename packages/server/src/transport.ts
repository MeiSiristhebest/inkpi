/**
 * 通用 RPC 传输层抽象
 */

/**
 * RPC 监听/连接的默认主机。仅回环地址——守护进程默认不暴露到外部网卡。
 * 需要对外暴露时必须在调用点显式传入 host（安全默认，而非散落的字面量）。
 */
export const DEFAULT_RPC_HOST = '127.0.0.1';

export interface RpcTransport {
  send(message: string): Promise<void> | void;
  onMessage(handler: (message: string) => void): void;
  close(): Promise<void> | void;
  isOpen(): boolean;
}

export class MemoryTransport implements RpcTransport {
  private peer?: MemoryTransport;
  private handlers: ((message: string) => void)[] = [];
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

  public close(): void {
    this.open = false;
    if (this.peer) {
      this.peer.open = false;
    }
  }

  public isOpen(): boolean {
    return this.open;
  }
}
