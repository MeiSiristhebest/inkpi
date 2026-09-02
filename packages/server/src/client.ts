import type {
  RpcRequest,
  RpcResponse,
  RpcNotification
} from '@inkpi/protocol';
import type { AgentMessage, ImageContent } from '@inkpi/protocol';
import type { InkRpcServer } from './server.js';
import type { RpcTransport } from './transport.js';
import { TcpSocketTransport } from './tcp-transport.js';

export interface Transport {
  sendRequest(req: RpcRequest): Promise<RpcResponse>;
  onNotification(handler: (notif: RpcNotification) => void): () => void;
}

/**
 * 内存内高效 Transport 实现 (同进程客户端与服务端直连)
 */
export class InMemoryTransport implements Transport {
  private server: InkRpcServer;
  private notifHandlers: Array<(notif: RpcNotification) => void> = [];

  constructor(server: InkRpcServer) {
    this.server = server;
    this.server.setNotificationSender((notif) => {
      for (const h of this.notifHandlers) {
        h(notif);
      }
    });
  }

  public async sendRequest(req: RpcRequest): Promise<RpcResponse> {
    return await this.server.handleRequest(req);
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
 * InkPi 类型安全 RPC 客户端
 */
export class InkRpcClient {
  private transport: Transport;
  private reqIdCounter = 1;
  private notificationListeners = new Map<string, Array<(params: any) => void>>();

  constructor(transport: Transport) {
    this.transport = transport;
    this.transport.onNotification((notif) => {
      const listeners = this.notificationListeners.get(notif.method);
      if (listeners) {
        for (const l of listeners) {
          l(notif.params);
        }
      }
    });
  }

  public static async connectTcp(port: number, host = '127.0.0.1'): Promise<InkRpcClient> {
    const rawTransport = await TcpSocketTransport.connect(port, host);
    const streamTransport = new RemoteStreamTransport(rawTransport);
    return new InkRpcClient(streamTransport);
  }

  public on(method: string, listener: (params: any) => void): () => void {
    const existing = this.notificationListeners.get(method) || [];
    existing.push(listener);
    this.notificationListeners.set(method, existing);
    return () => {
      const arr = this.notificationListeners.get(method);
      if (arr) {
        const idx = arr.indexOf(listener);
        if (idx !== -1) arr.splice(idx, 1);
      }
    };
  }

  public async call<T = any>(method: string, params?: any): Promise<T> {
    return this.request<T>(method, params);
  }

  public async request<T = any>(method: string, params?: any): Promise<T> {
    const req: RpcRequest = {
      jsonrpc: '2.0',
      id: this.reqIdCounter++,
      method,
      params
    };

    const res = await this.transport.sendRequest(req);
    if (res.error) {
      throw new Error(`[RPC ${res.error.code}] ${res.error.message}`);
    }
    return res.result as T;
  }

  // 1. Agent API
  public prompt(prompt: string, images?: ImageContent[]) {
    return this.request('agent.prompt', { prompt, images });
  }

  public steer(message: string | AgentMessage) {
    return this.request('agent.steer', { message });
  }

  public followUp(message: string | AgentMessage) {
    return this.request('agent.followUp', { message });
  }

  public getAgentState() {
    return this.request('agent.getState');
  }

  public abort() {
    return this.request('agent.abort');
  }

  public abortAgent() {
    return this.request('agent.abort');
  }

  // 2. Editor API
  public getEditorText(): Promise<string | { text: string }> {
    return this.request('editor.getText');
  }

  public insertEditorText(posOrText: number | string, text?: string) {
    if (typeof posOrText === 'string') {
      return this.request<{ text: string }>('editor.insertText', { text: posOrText });
    }
    return this.request<{ text: string }>('editor.insertText', { pos: posOrText, text: text || '' });
  }

  public replaceEditorRange(start: number, end: number, text: string) {
    return this.request<{ text: string }>('editor.replaceRange', { start, end, text });
  }

  public undoEditor() {
    return this.request<{ success: boolean }>('editor.undo');
  }

  public redoEditor() {
    return this.request<{ success: boolean }>('editor.redo');
  }

  // 3. Ghost text API
  public setGhostText(pos: number, text: string) {
    return this.request<{ suggestion?: string }>('ghost.set', { pos, text });
  }

  public suggestGhost(suggestion: string) {
    return this.request<{ suggestion?: string }>('ghost.suggest', { suggestion });
  }

  public acceptGhostText() {
    return this.request<{ accepted: boolean; text?: string }>('ghost.accept');
  }

  public acceptGhost() {
    return this.request<{ accepted: boolean; text?: string }>('ghost.accept');
  }

  public dismissGhost() {
    return this.request<{ success: boolean }>('ghost.dismiss');
  }

  // 4. Session Tree & Branches
  public branchTree(name: string, hypothesis?: string) {
    return this.request('tree.branch', { name, hypothesis });
  }

  public getBranches() {
    return this.request<any[]>('tree.getBranches');
  }

  public switchBranch(targetLeafId: string) {
    return this.request<{ currentLeafId: string; node: any }>('tree.switchBranch', { targetLeafId });
  }

  public navigateTree(nodeId: string) {
    return this.request('tree.navigate', { nodeId });
  }

  public getBranchSummary(fromLeafId?: string, toLeafId?: string) {
    return this.request('tree.getSummary', { fromLeafId, toLeafId });
  }

  // 5. Slash Commands
  public executeSlashCommand(command: string) {
    return this.request<{ handled: boolean; output: string }>('slash.execute', { command });
  }

  public executeSlash(command: string) {
    return this.request<{ handled: boolean; output: string }>('slash.execute', { command });
  }

  // 6. Pipeline
  public runWorkflow<T = any>(context: Record<string, unknown>) {
    return this.request<T>('workflow.run', context);
  }

  public runPipeline(bookTitle: string, chapterTitle: string, userPrompt: string) {
    return this.request<any>('pipeline.run', { bookTitle, chapterTitle, userPrompt });
  }

  // 7. Journal
  public appendJournal(type: string, payload: any, id?: string) {
    return this.request<{ id: string }>('journal.append', { type, payload, id });
  }

  public getJournalEntries() {
    return this.request<any[]>('journal.getEntries');
  }

  // 8. JIT Memory
  public retrieveJitMemory(params: any) {
    return this.request<any>('jit.retrieve', params);
  }

  // 9. FTS
  public searchFts(query: string, limit?: number) {
    return this.request<any[]>('storage.searchFts', { query, limit });
  }

  // 10. Telemetry
  public getTelemetryStats() {
    return this.request<any>('telemetry.getStats');
  }

  public getTelemetry() {
    return this.request('telemetry.getMetrics');
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
