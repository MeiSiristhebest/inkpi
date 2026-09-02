/**
 * WebSocket / HTTP 兼容 RPC 传输层 (1:1 对标 pi-server ws)
 */

import type { RpcTransport } from './transport.js';

export class WebSocketRpcTransport implements RpcTransport {
  private ws: any;
  private handlers: ((message: string) => void)[] = [];
  private open = true;

  constructor(ws: any) {
    this.ws = ws;
    if (typeof ws.on === 'function') {
      ws.on('message', (data: any) => {
        const str = data.toString('utf8');
        for (const handler of this.handlers) {
          handler(str);
        }
      });
      ws.on('close', () => {
        this.open = false;
      });
      ws.on('error', () => {
        this.open = false;
      });
    } else if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('message', (event: any) => {
        const str = typeof event.data === 'string' ? event.data : event.data.toString();
        for (const handler of this.handlers) {
          handler(str);
        }
      });
      ws.addEventListener('close', () => {
        this.open = false;
      });
    }
  }

  public send(message: string): void {
    if (!this.open) return;
    if (typeof this.ws.send === 'function') {
      this.ws.send(message);
    }
  }

  public onMessage(handler: (message: string) => void): void {
    this.handlers.push(handler);
  }

  public close(): void {
    this.open = false;
    if (typeof this.ws.close === 'function') {
      this.ws.close();
    }
  }

  public isOpen(): boolean {
    return this.open;
  }
}
