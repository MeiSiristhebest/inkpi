import * as net from 'node:net';
import type { Agent } from '@inkpi/agent-core';
import type { SessionTree } from '@inkpi/agent-core';
import { SlashCommandRegistry } from '@inkpi/agent-core';
import type { BranchSummarizer } from '@inkpi/agent-core';
import type { WorkflowCoordinator } from '@inkpi/agent-core';
import type { TelemetryCollector } from '@inkpi/agent-core';
import type { ExtensionHost } from '@inkpi/agent-core';
import type { GhostTextManager, HeadlessEditorState } from '@inkpi/editor-core';
import type { RpcNotification, RpcRequest, RpcResponse } from '@inkpi/protocol';
import type { AgentMessage } from '@inkpi/protocol';
import { RPC_ERROR_CODES } from '@inkpi/protocol';
import type { AppendOnlySessionJournal, FtsSearchEngine, InkRepository, JitMemoryRetriever } from '@inkpi/storage';
import { BUILTIN_RPC_METHODS, type RpcMethodHandler } from './builtin-methods.js';
import { TcpSocketTransport } from './tcp-transport.js';
import type { RpcTransport } from './transport.js';
import { DEFAULT_RPC_HOST } from './transport.js';
import { WebSocketRpcTransport } from './ws-transport.js';

export interface ServerContext {
  agent?: Agent;
  tree?: SessionTree;
  editor?: HeadlessEditorState;
  ghost?: GhostTextManager;
  storage?: InkRepository;
  fts?: FtsSearchEngine;
  slashRegistry?: SlashCommandRegistry;
  journal?: AppendOnlySessionJournal;
  jitRetriever?: JitMemoryRetriever;
  pipeline?: WorkflowCoordinator;
  telemetry?: TelemetryCollector;
  extensionHost?: ExtensionHost;
  branchSummarizer?: BranchSummarizer;
}

export type RpcNotificationSender = (notification: RpcNotification) => void;

/**
 * InkPi JSON-RPC 2.0 无头服务核心
 *
 * 原位于 `@inkpi/agent-core/src/rpc/server.ts`，作为传输层被错误地放在领域核心包内。
 * 现迁移至 `@inkpi/server`，使 agent-core 成为不依赖表现层 / 基础设施 / 传输层的
 * 纯净领域核心。详见 ARCHITECTURE.md §5。
 */
export class InkRpcServer {
  private ctx: ServerContext;
  private notificationSender?: RpcNotificationSender;
  private branchSummarizer?: BranchSummarizer;
  private boundTransports = new Set<RpcTransport>();
  private tcpServer: net.Server | null = null;
  private wsServer: any | null = null;
  private customHandlers = new Map<string, (params: any) => Promise<any> | any>();

  constructor(ctx: ServerContext = {}, notificationSender?: RpcNotificationSender) {
    this.ctx = {
      ...ctx,
      slashRegistry: ctx.slashRegistry || new SlashCommandRegistry()
    };
    this.branchSummarizer = this.ctx.branchSummarizer;
    this.notificationSender = notificationSender;

    // Attach agent event listener to stream notifications
    if (this.ctx.agent) {
      this.ctx.agent.subscribe((event) => {
        this.notify('agent.event', event);
      });
    }

    // Attach pipeline event listener if present
    if (this.ctx.pipeline) {
      this.ctx.pipeline.subscribe((event: any) => {
        this.notify('pipeline.event', event);
      });
    }
  }

  public setNotificationSender(sender: RpcNotificationSender): void {
    this.notificationSender = sender;
  }

  public registerMethod(name: string, handler: (params: any) => Promise<any> | any): void {
    this.customHandlers.set(name, handler);
  }

  public bindTransport(transport: RpcTransport): void {
    this.boundTransports.add(transport);
    transport.onMessage(async (msgStr) => {
      try {
        const req: RpcRequest = JSON.parse(msgStr);
        const res = await this.handleRequest(req);
        transport.send(JSON.stringify(res));
      } catch (err) {
        transport.send(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: RPC_ERROR_CODES.PARSE_ERROR, message: 'Invalid JSON message' }
          })
        );
      }
    });
  }

  public async listenTcp(port: number, host = DEFAULT_RPC_HOST): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        const transport = new TcpSocketTransport(socket);
        this.bindTransport(transport);
        socket.on('close', () => {
          this.boundTransports.delete(transport);
        });
      });

      server.on('error', reject);
      server.listen(port, host, () => {
        this.tcpServer = server;
        resolve(server);
      });
    });
  }

  /**
   * 监听 WebSocket 连接 (浏览器 / Tauri WebView 等 GUI 客户端可直接接入)
   * 复用与 TCP 完全相同的换行无关 JSON-RPC 消息协议 (每条 WS 消息即一条 RPC 消息)
   */
  public async listenWebSocket(port: number, host = DEFAULT_RPC_HOST): Promise<any> {
    const { createRequire } = await import('node:module');
    const nodeRequire = createRequire(import.meta.url);
    const { WebSocketServer } = nodeRequire('ws');
    const wss = new WebSocketServer({ port, host });
    wss.on('connection', (ws: any) => {
      const transport = new WebSocketRpcTransport(ws);
      this.bindTransport(transport);
      const cleanup = () => {
        this.boundTransports.delete(transport);
      };
      if (typeof ws.on === 'function') {
        ws.on('close', cleanup);
        ws.on('error', cleanup);
      }
    });
    this.wsServer = wss;
    return wss;
  }

  public async close(): Promise<void> {
    for (const t of this.boundTransports) {
      t.close();
    }
    this.boundTransports.clear();
    if (this.tcpServer) {
      await new Promise<void>((res) => this.tcpServer?.close(() => res()));
      this.tcpServer = null;
    }
    if (this.wsServer) {
      await new Promise<void>((res) => this.wsServer.close(() => res()));
      this.wsServer = null;
    }
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
    const notifStr = JSON.stringify(notif);
    for (const transport of this.boundTransports) {
      if (transport.isOpen()) {
        transport.send(notifStr);
      }
    }
  }

  public async handleRequest(req: RpcRequest): Promise<RpcResponse> {
    if (!req || req.jsonrpc !== '2.0' || !req.method) {
      return {
        jsonrpc: '2.0',
        id: req?.id ?? null,
        error: {
          code: RPC_ERROR_CODES.INVALID_REQUEST,
          message: 'Invalid RPC request structure'
        }
      };
    }

    try {
      const result = await this.dispatch(req.method, req.params || {});
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
          message: err.message || 'Internal server error',
          data: err.data
        }
      };
    }
  }

  private async dispatch(method: string, params: any): Promise<any> {
    if (this.customHandlers.has(method)) {
      return await this.customHandlers.get(method)!(params);
    }

    const builtinHandler = BUILTIN_RPC_METHODS[method];
    if (builtinHandler) {
      return await builtinHandler(params, this.ctx, this.branchSummarizer);
    }

    throw {
      code: RPC_ERROR_CODES.METHOD_NOT_FOUND,
      message: `Method '${method}' not found`
    };
  }
}

function normalizeAgentMessage(message: unknown, method: string): AgentMessage {
  if (typeof message === 'string') {
    if (message.trim().length === 0) throw new Error(`${method} requires a non-empty message`);
    return { role: 'user', content: message, timestamp: Date.now() };
  }
  if (!message || typeof message !== 'object' || !('role' in message)) {
    throw new Error(`${method} requires a string or AgentMessage`);
  }
  return message as AgentMessage;
}
