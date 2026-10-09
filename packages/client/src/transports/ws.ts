import type { RpcTransport } from '../types.js';

export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  readyState: number;
  addEventListener(type: 'message', listener: (ev: { data: any }) => void): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
}

/**
 * 通用 WebSocket RPC 传输层 (支持浏览器标准 WebSocket 与 Node.js ws)
 */
export class WebSocketTransport implements RpcTransport {
  private ws: MinimalWebSocket;
  private handlers: ((message: string) => void)[] = [];
  private closeHandlers: ((error?: Error) => void)[] = [];
  private open = true;

  constructor(ws: MinimalWebSocket) {
    this.ws = ws;

    this.ws.addEventListener('message', (ev) => {
      const msg = typeof ev.data === 'string' ? ev.data : String(ev.data);
      for (const handler of this.handlers) {
        handler(msg);
      }
    });

    this.ws.addEventListener('close', () => {
      this.markClosed(new Error('RPC WebSocket connection closed'));
    });

    this.ws.addEventListener('error', () => {
      this.markClosed(new Error('RPC WebSocket connection failed'));
    });
  }

  public send(message: string): void {
    if (!this.open) return;
    this.ws.send(message);
  }

  public onMessage(handler: (message: string) => void): void {
    this.handlers.push(handler);
  }

  public onClose(handler: (error?: Error) => void): void {
    if (!this.open) {
      handler(new Error('RPC WebSocket connection is closed'));
      return;
    }
    this.closeHandlers.push(handler);
  }

  public close(): void {
    this.markClosed(new Error('RPC WebSocket connection closed'));
    this.ws.close();
  }

  public isOpen(): boolean {
    return this.open && this.ws.readyState === 1; // 1 = OPEN
  }

  private markClosed(error?: Error): void {
    if (!this.open) return;
    this.open = false;
    for (const handler of this.closeHandlers) handler(error);
    this.closeHandlers = [];
  }
}
