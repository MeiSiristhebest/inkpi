import * as net from 'node:net';
import type {
  RpcRequest,
  RpcResponse,
  RpcNotification
} from '@meisiristhebest/protocol';
import { RPC_ERROR_CODES } from '@meisiristhebest/protocol';
import type { RpcNotificationSender } from './types.js';

export interface StandaloneServerContext {
  [key: string]: any;
}

/**
 * 独立的 JSON-RPC 2.0 服务端核心 (1:1 对标 pi-server)
 */
export class InkRpcServer {
  private ctx: StandaloneServerContext;
  private notificationSender?: RpcNotificationSender;
  private customHandlers = new Map<string, (params: any) => Promise<any> | any>();
  private tcpServer: net.Server | null = null;

  constructor(ctx: StandaloneServerContext = {}, notificationSender?: RpcNotificationSender) {
    this.ctx = { ...ctx };
    this.notificationSender = notificationSender;
  }

  public setNotificationSender(sender: RpcNotificationSender): void {
    this.notificationSender = sender;
  }

  public registerMethod(name: string, handler: (params: any) => Promise<any> | any): void {
    this.customHandlers.set(name, handler);
  }

  public notify(method: string, params?: any): void {
    const notif: RpcNotification = {
      jsonrpc: '2.0',
      method,
      params
    };
    if (this.notificationSender) {
      this.notificationSender(notif);
    }
  }

  public async handleRequest(req: RpcRequest): Promise<RpcResponse> {
    try {
      const handler = this.customHandlers.get(req.method);
      if (!handler) {
        return {
          jsonrpc: '2.0',
          id: req.id,
          error: {
            code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
            message: `Method '${req.method}' not found.`
          }
        };
      }
      const result = await handler(req.params || {});
      return {
        jsonrpc: '2.0',
        id: req.id,
        result
      };
    } catch (err: any) {
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: {
          code: err.code || RPC_ERROR_CODES.INTERNAL_ERROR,
          message: err.message || String(err),
          data: err.data
        }
      };
    }
  }

  public async close(): Promise<void> {
    if (this.tcpServer) {
      await new Promise<void>((res) => this.tcpServer?.close(() => res()));
      this.tcpServer = null;
    }
  }
}
