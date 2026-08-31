import type {
  RpcRequest,
  RpcResponse,
  RpcNotification
} from '@meisiristhebest/protocol';
import type { AgentMessage, ImageContent } from '@meisiristhebest/protocol';
import type { RpcTransport } from './types.js';
import { TcpSocketTransport } from './transports/tcp.js';
import { WebSocketTransport } from './transports/ws.js';

export interface Transport {
  sendRequest(req: RpcRequest): Promise<RpcResponse>;
  onNotification(handler: (notif: RpcNotification) => void): () => void;
}

/**
 * 内存内高效 Transport 实现 (同进程客户端与服务端直连)
 */
export class InMemoryTransport implements Transport {
  private handler: (req: RpcRequest) => Promise<RpcResponse>;
  private notifHandlers: Array<(notif: RpcNotification) => void> = [];

  constructor(serverOrHandler: { handleRequest: (req: RpcRequest) => Promise<RpcResponse>; setNotificationSender?: (sender: (n: RpcNotification) => void) => void } | ((req: RpcRequest) => Promise<RpcResponse>)) {
    if (typeof serverOrHandler === 'function') {
      this.handler = serverOrHandler;
    } else {
      this.handler = (req) => serverOrHandler.handleRequest(req);
      if (serverOrHandler.setNotificationSender) {
        serverOrHandler.setNotificationSender((notif) => {
          for (const h of this.notifHandlers) {
            h(notif);
          }
        });
      }
    }
  }

  public async sendRequest(req: RpcRequest): Promise<RpcResponse> {
    return await this.handler(req);
  }

  public onNotification(handler: (notif: RpcNotification) => void): () => void {
    this.notifHandlers.push(handler);
    return () => {
      const idx = this.notifHandlers.indexOf(handler);
      if (idx !== -1) this.notifHandlers.splice(idx, 1);
    };
  }
}

/**
 * 远程 Transport 实现 (基于 RpcTransport 流通道)
 */
export class RemoteStreamTransport implements Transport {
  private transport: RpcTransport;
  private pendingRequests = new Map<string | number, { resolve: (res: RpcResponse) => void; reject: (err: any) => void }>();
  private notifHandlers: Array<(notif: RpcNotification) => void> = [];

  constructor(transport: RpcTransport) {
    this.transport = transport;
    this.transport.onMessage((msgStr) => {
      try {
        const parsed = JSON.parse(msgStr);
        if ('id' in parsed && parsed.id !== null) {
          const pending = this.pendingRequests.get(parsed.id);
          if (pending) {
            this.pendingRequests.delete(parsed.id);
            pending.resolve(parsed as RpcResponse);
          }
        } else if ('method' in parsed) {
          for (const h of this.notifHandlers) {
            h(parsed as RpcNotification);
          }
        }
      } catch (err) {
        console.error('[RemoteStreamTransport] Failed to parse incoming message:', err);
      }
    });
  }

  public async sendRequest(req: RpcRequest): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      this.pendingRequests.set(req.id, { resolve, reject });
      this.transport.send(JSON.stringify(req));
    });
  }

  public onNotification(handler: (notif: RpcNotification) => void): () => void {
    this.notifHandlers.push(handler);
    return () => {
      const idx = this.notifHandlers.indexOf(handler);
      if (idx !== -1) this.notifHandlers.splice(idx, 1);
    };
  }

  public close(): void {
    this.transport.close();
  }
}

/**
 * InkPi 类型安全 RPC 客户端 (1:1 对标 pi-client)
 */
export class InkRpcClient {
  private transport: Transport;
  private reqIdCounter = 1;
  private listeners = new Map<string, Array<(params: any) => void>>();

  constructor(transport: Transport | RpcTransport) {
    if ('sendRequest' in transport) {
      this.transport = transport;
    } else {
      this.transport = new RemoteStreamTransport(transport);
    }

    this.transport.onNotification((notif) => {
      const handlers = this.listeners.get(notif.method);
      if (handlers) {
        for (const h of handlers) {
          h(notif.params);
        }
      }
    });
  }

  public static async connectTcp(port: number, host = '127.0.0.1'): Promise<InkRpcClient> {
    const rawTransport = await TcpSocketTransport.connect(port, host);
    return new InkRpcClient(rawTransport);
  }

  /**
   * 通过 WebSocket 连接 daemon (浏览器 / Tauri WebView 用全局 WebSocket,
   * Node.js 端自动回退到 ws 包)。对应服务端 InkPiDaemon.startWebSocket()。
   */
  public static async connectWebSocket(url: string): Promise<InkRpcClient> {
    const g = globalThis as any;
    let ws: any;
    if (typeof g.WebSocket !== 'undefined') {
      ws = new g.WebSocket(url);
    } else {
      // 动态拼接模块名 + @vite-ignore, 避免浏览器打包器静态解析 node 内置模块
      const nodeModuleSpecifier = 'node:' + 'module';
      const { createRequire } = await import(/* @vite-ignore */ nodeModuleSpecifier);
      const nodeRequire = createRequire(import.meta.url);
      const { WebSocket: NodeWebSocket } = nodeRequire('ws');
      ws = new NodeWebSocket(url);
    }

    await new Promise<void>((resolve, reject) => {
      if (ws.readyState === 1) {
        resolve();
        return;
      }
      const cleanup = () => {
        ws.removeEventListener?.('open', onOpen);
        ws.removeEventListener?.('error', onError);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error(`WebSocket connection failed: ${url}`));
      };
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });

    return new InkRpcClient(new WebSocketTransport(ws));
  }

  public async request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    const id = this.reqIdCounter++;
    const req: RpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params
    };

    const res = await this.transport.sendRequest(req);
    if (res.error) {
      const err = new Error(res.error.message);
      (err as any).code = res.error.code;
      (err as any).data = res.error.data;
      throw err;
    }
    return res.result as T;
  }

  public on(event: string, listener: (params: any) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(listener);
    return () => {
      const list = this.listeners.get(event);
      if (list) {
        const idx = list.indexOf(listener);
        if (idx !== -1) list.splice(idx, 1);
      }
    };
  }

  // --- 强类型常用方法 ---

  public prompt(text: string, images?: ImageContent[]) {
    return this.request<{ success: boolean; turnId: string; messages: AgentMessage[] }>('agent.prompt', {
      prompt: text,
      images
    });
  }

  public steer(text: string) {
    return this.request<{ success: boolean }>('agent.steer', { prompt: text });
  }

  public abort() {
    return this.request<{ success: boolean }>('agent.abort');
  }

  public getSessionState() {
    return this.request<{
      messages: AgentMessage[];
      branches: Array<{ leafId: string; length: number }>;
      editorText?: string;
      ghostText?: string;
    }>('session.getState');
  }

  public executeCommand(command: string, args: string) {
    return this.request<unknown>('command.execute', { command, args });
  }

  public editorInsert(pos: number, text: string) {
    return this.request<string>('editor.insert', { pos, text });
  }

  public editorDelete(from: number, to: number) {
    return this.request<string>('editor.delete', { from, to });
  }

  public editorUndo() {
    return this.request<{ success: boolean; text: string }>('editor.undo');
  }

  public editorRedo() {
    return this.request<{ success: boolean; text: string }>('editor.redo');
  }

  public suggestGhostText(text: string) {
    return this.request<{ success: boolean; ghostText: string }>('ghost.suggest', { text });
  }

  public acceptGhostText(mode: 'all' | 'word' | 'line' = 'all') {
    return this.request<{ success: boolean; acceptedText: string; mode: string }>('ghost.accept', { mode });
  }

  public dismissGhostText() {
    return this.request<{ success: boolean }>('ghost.dismiss');
  }

  public queryMemory(query: string, limit = 5) {
    return this.request<Array<{ key: string; value: string; score: number }>>('storage.queryMemory', { query, limit });
  }

  public searchFts(query: string, limit = 10) {
    return this.request<Array<{ documentId: string; title: string; snippet: string }>>('storage.searchFts', { query, limit });
  }

  public triggerWorkflow(userPrompt: string, title?: string) {
    return this.request<{ success: boolean; result: unknown }>('pipeline.run', { userPrompt, title });
  }

  public getTelemetry() {
    return this.request<unknown>('telemetry.getMetrics');
  }

  public exportOpenTelemetry() {
    return this.request<string>('telemetry.exportOtel');
  }

  public onNotification(handler: (notif: RpcNotification) => void): () => void {
    return this.transport.onNotification(handler);
  }

  public async close(): Promise<void> {
    if ((this.transport as any).close) {
      (this.transport as any).close();
    }
  }
}
