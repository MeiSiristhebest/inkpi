import { RpcBufferedSender, type RpcLimits, resolveRpcLimits, rpcFrameBytes } from '@inkpi/protocol';
import type { RpcTransport } from './transport.js';

export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  readyState?: number;
  bufferedAmount?: number;
  addEventListener?(type: string, listener: (event: any) => void): void;
  on?(type: string, listener: (...args: any[]) => void): void;
}

/** JSON text WebSocket frames and a bounded native send buffer. */
export class WebSocketRpcTransport implements RpcTransport {
  private readonly handlers = new Set<(message: string) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private readonly limits: RpcLimits;
  private readonly sender: RpcBufferedSender;
  private closedError?: Error;
  constructor(
    private readonly ws: MinimalWebSocket,
    options?: Partial<RpcLimits>
  ) {
    this.limits = resolveRpcLimits(options);
    this.sender = new RpcBufferedSender(
      this.limits,
      () => ws.bufferedAmount ?? 0,
      (message) => ws.send(message),
      (error) => this.fail(error)
    );
    if (typeof ws.on === 'function') {
      ws.on('message', (data: any, isBinary?: boolean) => {
        if (isBinary) {
          this.fail(new Error('RPC WebSocket requires text frames'));
          return;
        }
        if (typeof data?.byteLength === 'number' && data.byteLength > this.limits.maxFrameBytes) {
          this.fail(new Error('RPC frame exceeds byte limit'));
          return;
        }
        this.consume(typeof data === 'string' ? data : data.toString('utf8'));
      });
      ws.on('close', () => this.markClosed(new Error('RPC WebSocket connection closed')));
      ws.on('error', (error: Error) => this.fail(error));
    } else if (ws.addEventListener) {
      ws.addEventListener('message', (event: any) => {
        if (typeof event.data !== 'string') {
          this.fail(new Error('RPC WebSocket requires text frames'));
          return;
        }
        this.consume(event.data);
      });
      ws.addEventListener('close', () => this.markClosed(new Error('RPC WebSocket connection closed')));
      ws.addEventListener('error', () => this.fail(new Error('RPC WebSocket connection failed')));
    } else throw new Error('WebSocket does not expose message and close events');
  }
  send(message: string): Promise<void> {
    if (!this.isOpen()) return Promise.reject(this.closedError ?? new Error('RPC WebSocket connection closed'));
    return this.sender.send(message);
  }
  onMessage(handler: (message: string) => void): void {
    this.handlers.add(handler);
  }
  onClose(handler: (error?: Error) => void): void {
    if (this.closedError) handler(this.closedError);
    else this.closeHandlers.add(handler);
  }
  close(): void {
    this.fail(new Error('RPC WebSocket connection closed'));
  }
  isOpen(): boolean {
    return !this.closedError && (this.ws.readyState === undefined || this.ws.readyState === 1);
  }
  private consume(message: string): void {
    if (this.closedError) return;
    try {
      rpcFrameBytes(message, this.limits);
      for (const handler of [...this.handlers]) handler(message);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Invalid RPC WebSocket frame'));
    }
  }
  private fail(error: Error): void {
    this.markClosed(error);
    this.ws.close();
  }
  private markClosed(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.sender.close(error);
    this.handlers.clear();
    for (const handler of this.closeHandlers) {
      try {
        handler(error);
      } catch {
        /* Drain every connection waiter. */
      }
    }
    this.closeHandlers.clear();
  }
}
