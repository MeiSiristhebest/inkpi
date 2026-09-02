import * as net from 'node:net';
import { InkRpcServer, type ServerContext } from './server.js';
import { SessionRegistry, type ManagedSession, type SessionCreateOptions } from '@inkpi/agent-core';
import type { RpcTransport } from './transport.js';
import { TcpSocketTransport } from './tcp-transport.js';
import type { ModelConfig } from '@inkpi/protocol';

export interface DaemonOptions {
  port?: number;
  host?: string;
  wsPort?: number;
  defaultModel?: ModelConfig;
  context?: Partial<ServerContext>;
}

export interface DaemonStatus {
  running: boolean;
  port?: number;
  host?: string;
  wsPort?: number | null;
  activeSessions: number;
  uptimeMs: number;
}

/**
 * InkPi 常驻守护进程 (InkPi Daemon)
 *
 * 原位于 `@inkpi/agent-core/src/rpc/daemon.ts`，作为表现/传输层被错误地放在了
 * 领域核心包内。现迁移至 `@inkpi/server`（传输层包），使 agent-core 成为不依赖
 * 表现层 / 基础设施 / 传输层的纯净领域核心。详见 ARCHITECTURE.md §5。
 */
export class InkPiDaemon {
  private rpcServer: InkRpcServer;
  private sessionManager: SessionRegistry;
  private startTime = 0;
  private running = false;
  private tcpServer: net.Server | null = null;
  private wsPort: number | null = null;
  private options: DaemonOptions;

  constructor(options: DaemonOptions = {}) {
    this.options = {
      port: 41829,
      host: '127.0.0.1',
      ...options
    };
    this.sessionManager = new SessionRegistry(options.defaultModel);
    this.rpcServer = new InkRpcServer(options.context as ServerContext);
    this.registerDaemonMethods();
  }

  public getSessionManager(): SessionRegistry {
    return this.sessionManager;
  }

  public getRpcServer(): InkRpcServer {
    return this.rpcServer;
  }

  /** 返回守护进程实际监听的 TCP 端口（端口 0 时由操作系统分配）。 */
  public getPort(): number {
    return this.options.port ?? 0;
  }

  private registerDaemonMethods(): void {
    // 1. Session Management RPCs
    this.rpcServer.registerMethod('daemon.status', () => this.getStatus());

    this.rpcServer.registerMethod('session.create', (params: SessionCreateOptions) => {
      const session = this.sessionManager.createSession(params);
      // Hook session agent events to broadcast
      session.agent.subscribe((event) => {
        this.rpcServer.notify('session.event', {
          sessionId: session.sessionId,
          event
        });
      });
      return {
        sessionId: session.sessionId,
        createdAt: session.createdAt,
        messageCount: session.agent.state.messages.length
      };
    });

    this.rpcServer.registerMethod('session.list', () => {
      return this.sessionManager.listSessions();
    });

    this.rpcServer.registerMethod('session.close', (params: { sessionId: string }) => {
      return { success: this.sessionManager.closeSession(params?.sessionId) };
    });

    this.rpcServer.registerMethod('session.prompt', async (params: { sessionId: string; prompt: string }) => {
      const session = this.withSession(params?.sessionId);
      await session.agent.prompt(params.prompt);
      return {
        success: true,
        sessionId: session.sessionId,
        messageCount: session.agent.state.messages.length,
        lastMessage: session.agent.state.messages[session.agent.state.messages.length - 1]
      };
    });

    this.rpcServer.registerMethod('session.abort', (params: { sessionId: string }) => {
      const session = this.withSession(params?.sessionId);
      session.agent.abort();
      return { success: true };
    });

    const getStateHandler = (params: { sessionId: string }) => {
      const session = this.withSession(params?.sessionId);
      return {
        sessionId: session.sessionId,
        messages: session.agent.state.messages,
        isStreaming: session.agent.state.isStreaming,
        editorText: session.editor.getText(),
        hasGhostText: session.ghost.hasGhostText(),
        ghostText: session.ghost.getGhostText()
      };
    };
    // session.getState 为 client SDK 兼容别名
    this.rpcServer.registerMethod('session.get_state', getStateHandler);
    this.rpcServer.registerMethod('session.getState', getStateHandler);

    // 2. Editor Multi-session RPCs
    this.rpcServer.registerMethod('session.editor.insert', (params: { sessionId: string; pos: number; text: string }) => {
      const session = this.withSession(params?.sessionId);
      session.editor.insertText(params.pos, params.text);
      return { text: session.editor.getText(), version: session.editor.getVersion() };
    });

    this.rpcServer.registerMethod('session.editor.undo', (params: { sessionId: string }) => {
      const session = this.withSession(params?.sessionId);
      const success = session.editor.undo();
      return { success, text: session.editor.getText() };
    });

    this.rpcServer.registerMethod('session.editor.redo', (params: { sessionId: string }) => {
      const session = this.withSession(params?.sessionId);
      const success = session.editor.redo();
      return { success, text: session.editor.getText() };
    });

    this.rpcServer.registerMethod('session.ghost.suggest', (params: { sessionId: string; text: string; pos?: number }) => {
      const session = this.withSession(params?.sessionId);
      const suggestion = session.ghost.suggest(params.text, params.pos);
      return suggestion;
    });

    this.rpcServer.registerMethod('session.ghost.accept', (params: { sessionId: string; mode?: 'all' | 'word' | 'line' }) => {
      const session = this.withSession(params?.sessionId);
      let accepted = false;
      if (params.mode === 'word') {
        accepted = session.ghost.acceptWord();
      } else if (params.mode === 'line') {
        accepted = session.ghost.acceptLine();
      } else {
        accepted = session.ghost.acceptGhostText();
      }
      return { accepted, text: session.editor.getText() };
    });

    this.rpcServer.registerMethod('session.ghost.dismiss', (params: { sessionId: string }) => {
      const session = this.withSession(params?.sessionId);
      session.ghost.dismiss();
      return { success: true };
    });
  }

  /**
   * 提取「取会话 / 找不到就抛错」的样板（原在 registerDaemonMethods 中重复 9 次）。
   * 既消除重复，也成为后续 RPC 方法注册表（OCP）的统一前置守卫。
   */
  private withSession(sessionId: string): ManagedSession {
    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      throw new Error(`Session '${sessionId}' not found.`);
    }
    return session;
  }

  public async start(port = this.options.port, host = this.options.host): Promise<this> {
    if (this.running) return this;
    this.startTime = Date.now();
    this.tcpServer = await this.rpcServer.listenTcp(port!, host!);
    this.running = true;
    // When binding to port 0 the OS assigns a free port; record the real one so
    // clients (and tests) can discover it instead of assuming the requested port.
    const addr = this.tcpServer.address();
    if (addr && typeof addr === 'object') {
      this.options.port = addr.port;
    } else {
      this.options.port = port;
      this.options.host = host;
    }
    return this;
  }

  /**
   * 额外开启 WebSocket 监听 (浏览器 / Tauri WebView GUI 客户端入口)
   * 默认端口为 TCP 端口 + 1
   */
  public async startWebSocket(wsPort = (this.options.port ?? 41829) + 1, host = this.options.host): Promise<this> {
    this.wsPort = wsPort;
    this.options.wsPort = wsPort;
    await this.rpcServer.listenWebSocket(wsPort!, host!);
    return this;
  }

  public attachTransport(transport: RpcTransport): void {
    this.rpcServer.bindTransport(transport);
  }

  public async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.sessionManager.clear();
    await this.rpcServer.close();
    this.tcpServer = null;
    this.wsPort = null;
  }

  public getStatus(): DaemonStatus {
    return {
      running: this.running,
      port: this.options.port,
      host: this.options.host,
      wsPort: this.wsPort,
      activeSessions: this.sessionManager.size,
      uptimeMs: this.running ? Date.now() - this.startTime : 0
    };
  }
}
