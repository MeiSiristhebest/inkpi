/**
 * 通用 RPC 传输层抽象 (1:1 对标 pi-client / pi-server transport)
 */

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
      if (this.peer && this.peer.open) {
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
