import * as net from 'node:net';
import type { Agent } from '@inkpi/agent-core';
import type { TaskRouter } from '@inkpi/agent-core';
import type { ProgressiveSkillRuntime } from '@inkpi/agent-core';
import type { SessionTree } from '@inkpi/agent-core';
import { SlashCommandRegistry } from '@inkpi/agent-core';
import type { BranchSummarizer } from '@inkpi/agent-core';
import type { TelemetryCollector } from '@inkpi/agent-core';
import type { ExtensionHost } from '@inkpi/agent-core';
import type { TaskCheckpointStore } from '@inkpi/agent-core';
import type { TaskExecutionStore } from '@inkpi/agent-core';
import type { ContextPipeline } from '@inkpi/agent-core';
import type { ContextProvider } from '@inkpi/agent-core';
import type { InstructionRegistry } from '@inkpi/agent-core';
import type { TaskSchedulerPersistence } from '@inkpi/agent-core';
import type { GhostTextManager, HeadlessEditorState } from '@inkpi/editor-core';
import type { ArtifactStore, RpcNotification, RpcRequest, RpcResponse } from '@inkpi/protocol';
import { type JsonObject, type JsonValue, assertJsonValue } from '@inkpi/protocol';
import { RPC_ERROR_CODES } from '@inkpi/protocol';
import { type RpcLimits, isSessionAttachment, resolveRpcLimits, rpcFrameBytes } from '@inkpi/protocol';
import type { RpcMethodRegistrationHandler } from '@inkpi/protocol';
import type {
  AppendOnlySessionJournal,
  FtsSearchEngine,
  InkRepository,
  JitMemoryRetriever,
  LaneManager
} from '@inkpi/storage';
import type { DomainProjectionStore } from '@inkpi/storage';
import type { ProposalProjectionStore } from '@inkpi/storage';
import { BUILTIN_RPC_METHODS } from './builtin-methods.js';
import { SessionRouting } from './session-routing.js';
import { TcpSocketTransport } from './tcp-transport.js';
import type { RpcTransport } from './transport.js';
import { DEFAULT_RPC_HOST } from './transport.js';
import { WebSocketRpcTransport } from './ws-transport.js';

export interface ServerContext {
  agent?: Agent;
  taskRouter?: TaskRouter;
  domainProjection?: DomainProjectionStore;
  proposalProjection?: ProposalProjectionStore;
  artifactStore?: ArtifactStore;
  checkpointStore?: TaskCheckpointStore;
  executionStore?: TaskExecutionStore;
  schedulerPersistence?: TaskSchedulerPersistence;
  contextPipeline?: ContextPipeline;
  /** Host-owned providers registered into the Daemon's shared pipeline. */
  contextProviders?: readonly ContextProvider[];
  instructionRegistry?: InstructionRegistry;
  skillRuntime?: ProgressiveSkillRuntime;
  tree?: SessionTree;
  editor?: HeadlessEditorState;
  ghost?: GhostTextManager;
  storage?: InkRepository;
  fts?: FtsSearchEngine;
  slashRegistry?: SlashCommandRegistry;
  journal?: AppendOnlySessionJournal;
  laneManager?: LaneManager;
  jitRetriever?: JitMemoryRetriever;
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
  private readonly limits: RpcLimits;
  private ctx: ServerContext;
  private notificationSender?: RpcNotificationSender;
  private readonly directNotificationSenders = new Map<string, RpcNotificationSender>();
  private sessionRouting?: SessionRouting;
  private readonly connections = new WeakMap<RpcTransport, string>();
  private branchSummarizer?: BranchSummarizer;
  private boundTransports = new Set<RpcTransport>();
  private tcpServer: net.Server | null = null;
  private wsServer: any | null = null;
  private customHandlers = new Map<string, (params: any, connectionId?: string) => Promise<any> | any>();

  constructor(ctx: ServerContext = {}, notificationSender?: RpcNotificationSender, limits?: Partial<RpcLimits>) {
    this.limits = resolveRpcLimits(limits);
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
  }

  public setNotificationSender(sender: RpcNotificationSender): void {
    this.notificationSender = sender;
  }

  public registerDirectConnection(connectionId: string, sender: RpcNotificationSender): () => void {
    this.directNotificationSenders.set(connectionId, sender);
    return () => {
      if (this.directNotificationSenders.get(connectionId) === sender)
        this.directNotificationSenders.delete(connectionId);
      this.sessionRouting?.release(connectionId);
    };
  }

  public getContext(): ServerContext {
    return this.ctx;
  }

  public configureSessionRouting(resolveSession: (sessionId: string) => object | undefined): void {
    if (this.sessionRouting) throw new Error('Session routing is already configured');
    this.sessionRouting = new SessionRouting(resolveSession);
  }

  public attachSession(
    connectionId: string,
    params: import('@inkpi/protocol').SessionAttachParams
  ): import('@inkpi/protocol').SessionAttachment {
    if (!this.sessionRouting) throw new Error('Session routing is not configured');
    return this.sessionRouting.attach(connectionId, params);
  }

  public registerMethod<K extends string>(name: K, handler: RpcMethodRegistrationHandler<K>): void {
    this.customHandlers.set(name, handler as (params: any, connectionId?: string) => Promise<any> | any);
  }

  public bindTransport(transport: RpcTransport): void {
    this.boundTransports.add(transport);
    const connectionId = crypto.randomUUID();
    this.connections.set(transport, connectionId);
    transport.onClose?.(() => {
      this.boundTransports.delete(transport);
      this.sessionRouting?.release(connectionId);
    });
    let activeRequests = 0;
    transport.onMessage(async (msgStr) => {
      if (!transport.isOpen()) return;
      try {
        rpcFrameBytes(msgStr, this.limits);
      } catch {
        await transport.close();
        return;
      }
      if (activeRequests >= this.limits.maxPendingRequests) {
        await transport.close();
        return;
      }
      activeRequests++;
      let res: RpcResponse;
      try {
        const req: RpcRequest = JSON.parse(msgStr);
        res = await this.handleRequest(req, connectionId);
      } catch {
        res = {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: RPC_ERROR_CODES.PARSE_ERROR,
            message: 'Invalid JSON message'
          }
        };
      }
      try {
        if (transport.isOpen()) await transport.send(JSON.stringify(res));
      } catch {
        await transport.close();
      } finally {
        activeRequests--;
      }
    });
  }

  public async listenTcp(port: number, host = DEFAULT_RPC_HOST): Promise<net.Server> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        const transport = new TcpSocketTransport(socket, this.limits);
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
    const wss = new WebSocketServer({ port, host, maxPayload: this.limits.maxFrameBytes });
    wss.on('connection', (ws: any) => {
      const transport = new WebSocketRpcTransport(ws, this.limits);
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
      await t.close();
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

  public notify(method: string, params?: unknown): void {
    if (method === 'session.event' && this.sessionRouting)
      throw new Error('Use notifySessionEvent to preserve session attachment routes');
    const safeParams = params === undefined ? undefined : normalizeJsonBoundary(params, 'RPC notification params');
    const notif: RpcNotification = {
      jsonrpc: '2.0',
      method,
      params: safeParams
    };
    if (this.notificationSender) {
      this.notificationSender(notif);
    }
    for (const [connectionId, sender] of this.directNotificationSenders) {
      try {
        sender(structuredClone(notif));
      } catch {
        this.directNotificationSenders.delete(connectionId);
        this.sessionRouting?.release(connectionId);
      }
    }
    for (const transport of this.boundTransports) {
      this.sendNotification(transport, notif);
    }
  }

  public notifySessionEvent(sessionId: string, source: object, event: unknown): void {
    const params = normalizeJsonBoundary({ sessionId, event }, 'RPC session event');
    const directRoute = this.sessionRouting?.routeForEvent('direct', sessionId, source);
    if (directRoute !== null && (!this.sessionRouting || directRoute !== undefined))
      this.notificationSender?.({
        jsonrpc: '2.0',
        method: 'session.event',
        params,
        ...(directRoute ? { route: directRoute } : {})
      });
    for (const [connectionId, sender] of this.directNotificationSenders) {
      const route = this.sessionRouting?.routeForEvent(connectionId, sessionId, source);
      if (route !== null) {
        try {
          sender({ jsonrpc: '2.0', method: 'session.event', params, ...(route ? { route } : {}) });
        } catch {
          this.directNotificationSenders.delete(connectionId);
          this.sessionRouting?.release(connectionId);
        }
      }
    }
    for (const transport of this.boundTransports) {
      const route = this.sessionRouting?.routeForEvent(this.connections.get(transport)!, sessionId, source);
      if (route !== null)
        this.sendNotification(transport, {
          jsonrpc: '2.0',
          method: 'session.event',
          params,
          ...(route ? { route } : {})
        });
    }
  }

  private sendNotification(transport: RpcTransport, notification: RpcNotification): void {
    if (!transport.isOpen()) return;
    try {
      void Promise.resolve(transport.send(JSON.stringify(notification))).catch(() => {
        this.boundTransports.delete(transport);
        void Promise.resolve(transport.close()).catch(() => undefined);
      });
    } catch {
      this.boundTransports.delete(transport);
      void Promise.resolve(transport.close()).catch(() => undefined);
    }
  }

  public async handleRequest(inputRequest: RpcRequest, connectionId = 'direct'): Promise<RpcResponse> {
    const req = inputRequest && {
      ...inputRequest,
      ...(inputRequest.route ? { route: structuredClone(inputRequest.route) } : {})
    };
    if (
      !req ||
      req.jsonrpc !== '2.0' ||
      typeof req.method !== 'string' ||
      !req.method.trim() ||
      (typeof req.id !== 'string' && (typeof req.id !== 'number' || !Number.isFinite(req.id))) ||
      (req.route !== undefined && !isSessionAttachment(req.route))
    ) {
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
      const safeParams = req.params === undefined ? undefined : normalizeJsonBoundary(req.params, 'RPC request params');
      const safeRequest = { ...req, params: safeParams };
      this.sessionRouting?.assertRequest(connectionId, safeRequest);
      const result = await this.dispatch(req.method, safeParams ?? {}, connectionId);
      if (req.method !== 'session.close') this.sessionRouting?.assertRequest(connectionId, safeRequest);
      return {
        jsonrpc: '2.0',
        id: req.id,
        result: normalizeJsonBoundary(result, 'RPC response result'),
        ...(req.route ? { route: req.route } : {})
      };
    } catch (err: any) {
      return {
        jsonrpc: '2.0',
        id: req.id,
        ...(req.route ? { route: req.route } : {}),
        error: {
          code: err.code || RPC_ERROR_CODES.INTERNAL_ERROR,
          message: err.message || 'Internal server error',
          ...(normalizeRpcErrorData(err.data) === undefined ? {} : { data: normalizeRpcErrorData(err.data) })
        }
      };
    }
  }

  private async dispatch(method: string, params: any, connectionId = 'direct'): Promise<any> {
    if (this.customHandlers.has(method)) {
      return await this.customHandlers.get(method)!(params, connectionId);
    }
    if (method === 'session.attach') return this.attachSession(connectionId, params);

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

function normalizeRpcErrorData(value: unknown): JsonValue | undefined {
  if (value === undefined) return undefined;
  try {
    return normalizeJsonBoundary(value, 'RPC error data');
  } catch {
    return undefined;
  }
}

function normalizeJsonBoundary(value: unknown, context: string): JsonValue {
  const normalized = removeUndefined(value, context);
  if (normalized === undefined) throw new Error(`${context} must not be undefined`);
  assertJsonValue(normalized, context);
  return normalized;
}

function removeUndefined(value: unknown, context: string): JsonValue | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${context} contains a non-finite number`);
    return value;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const normalized = removeUndefined(item, context);
      if (normalized === undefined) throw new Error(`${context} contains undefined array values`);
      result.push(normalized);
    }
    return result;
  }
  if (
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    const result: JsonObject = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const normalized = removeUndefined(item, `${context}.${key}`);
      if (normalized !== undefined) result[key] = normalized;
    }
    return result;
  }
  throw new Error(`${context} contains a non-JSON value`);
}
