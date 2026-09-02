/**
 * Node.js 原生 TCP RPC 传输层实现 (带换行符消息帧隔离)
 */

import * as net from 'node:net';
import type { RpcTransport } from './transport.js';

export class TcpSocketTransport implements RpcTransport {
  private socket: net.Socket;
  private handlers: ((message: string) => void)[] = [];
  private buffer = '';
  private open = true;

  constructor(socket: net.Socket) {
    this.socket = socket;
    this.socket.setEncoding('utf8');

    this.socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newlineIdx = this.buffer.indexOf('\n');
      while (newlineIdx !== -1) {
        const line = this.buffer.slice(0, newlineIdx).trim();
        this.buffer = this.buffer.slice(newlineIdx + 1);
        if (line) {
          for (const handler of this.handlers) {
            handler(line);
          }
        }
        newlineIdx = this.buffer.indexOf('\n');
      }
    });

    this.socket.on('close', () => {
      this.open = false;
    });

    this.socket.on('error', () => {
      this.open = false;
    });
  }

  public static async connect(port: number, host = '127.0.0.1'): Promise<TcpSocketTransport> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ port, host }, () => {
        resolve(new TcpSocketTransport(socket));
      });
      socket.on('error', reject);
    });
  }

  public send(message: string): void {
    if (!this.open) return;
    this.socket.write(message + '\n');
  }

  public onMessage(handler: (message: string) => void): void {
    this.handlers.push(handler);
  }

  public close(): void {
    this.open = false;
    this.socket.destroy();
  }

  public isOpen(): boolean {
    return this.open;
  }
}
