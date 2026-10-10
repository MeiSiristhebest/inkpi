import * as net from 'node:net';
import { type RpcLimits, RpcLineBuffer, RpcSendWindow, resolveRpcLimits } from '@inkpi/protocol';
import type { RpcTransport } from '../types.js';
import { DEFAULT_RPC_HOST } from '../types.js';

/** Newline-framed TCP with bounded partial frames and owned pending writes. */
export class TcpSocketTransport implements RpcTransport {
  private readonly handlers = new Set<(message: string) => void>();
  private readonly closeHandlers = new Set<(error?: Error) => void>();
  private readonly pendingWrites = new Set<(error: Error) => void>();
  private readonly limits: RpcLimits;
  private readonly frames: RpcLineBuffer;
  private readonly sends: RpcSendWindow;
  private closedError?: Error;

  constructor(
    private readonly socket: net.Socket,
    options?: Partial<RpcLimits>
  ) {
    this.limits = resolveRpcLimits(options);
    this.frames = new RpcLineBuffer(this.limits);
    this.sends = new RpcSendWindow(this.limits);
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      if (this.closedError) return;
      try {
        for (const message of this.frames.push(chunk)) {
          for (const handler of [...this.handlers]) handler(message);
        }
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('Invalid RPC TCP frame'));
      }
    });
    socket.on('close', () => this.markClosed(new Error('RPC TCP connection closed')));
    socket.on('error', (error) => this.fail(error));
  }

  static async connect(
    port: number,
    host = DEFAULT_RPC_HOST,
    options?: Partial<RpcLimits>
  ): Promise<TcpSocketTransport> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host }, () => resolve(new TcpSocketTransport(socket, options)));
      socket.once('error', reject);
    });
  }
  send(message: string): Promise<void> {
    if (!this.isOpen()) return Promise.reject(this.closedError ?? new Error('RPC TCP connection closed'));
    let release: () => void;
    try {
      release = this.sends.reserve(message, this.socket.writableLength);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error('RPC TCP send failed');
      this.fail(failure);
      return Promise.reject(failure);
    }
    return new Promise((resolve, reject) => {
      const finish = (error?: Error | null) => {
        clearTimeout(timer);
        release();
        this.pendingWrites.delete(cancel);
        if (error) reject(error);
        else resolve();
      };
      const cancel = (error: Error) => finish(error);
      const timer = setTimeout(() => this.fail(new Error('RPC TCP send timed out')), this.limits.requestTimeoutMs);
      this.pendingWrites.add(cancel);
      try {
        this.socket.write(`${message}\n`, (error) => finish(error));
      } catch (error) {
        finish(error instanceof Error ? error : new Error('RPC TCP send failed'));
      }
    });
  }
  onMessage(handler: (message: string) => void): void {
    this.handlers.add(handler);
  }
  onClose(handler: (error?: Error) => void): void {
    if (this.closedError) handler(this.closedError);
    else this.closeHandlers.add(handler);
  }
  close(): void {
    this.fail(new Error('RPC TCP connection closed'));
  }
  isOpen(): boolean {
    return !this.closedError && !this.socket.destroyed;
  }
  private fail(error: Error): void {
    this.markClosed(error);
    this.socket.destroy();
  }
  private markClosed(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    this.frames.clear();
    this.handlers.clear();
    for (const reject of this.pendingWrites) reject(error);
    this.pendingWrites.clear();
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
