import type {
  AiTask,
  Artifact,
  ArtifactGetParams,
  ArtifactListParams,
  ArtifactSaveParams,
  ArtifactSaveResult,
  CacheInvalidateParams,
  CacheInvalidateResult,
  CacheStatus,
  DiagnosticSnapshot,
  DomainChangeSet,
  DomainProjectionApplyResult,
  DomainProjectionSnapshot,
  DomainSyncPage,
  DomainSyncPageParams,
  DomainWatchEvent,
  DomainWatchOptions,
  ProposalProjectionSnapshot,
  ProposalProjectionState,
  ProposalSyncPushResult,
  RpcNotification,
  RpcRequest,
  RpcResponse,
  TaskAdmissionReceipt,
  TaskCancelResult,
  TaskExecutionParams,
  TaskExecutionSnapshot,
  TaskForkParams,
  TaskReplayParams,
  TaskResult,
  TaskResumeParams,
  TaskStatusSnapshot,
  TaskSteerParams,
  TaskSteerResult,
  TaskSubmitResult
} from '@inkpi/protocol';
import {
  type RpcLimits,
  type RpcRequestOptions,
  RpcSessionAttachment,
  RpcStreamRequests,
  type SessionAttachment,
  awaitWithAbort,
  calculateProposalProjectionStateHash,
  observeTaskResult,
  sameSessionAttachment,
  watchDomainChanges
} from '@inkpi/protocol';
import type { AgentMessage, ImageContent } from '@inkpi/protocol';
import type { InkRpcServer } from './server.js';
import { TcpSocketTransport } from './tcp-transport.js';
import type { RpcTransport } from './transport.js';
import { DEFAULT_RPC_HOST } from './transport.js';

export interface Transport {
  sendRequest(req: RpcRequest, options?: RpcRequestOptions): Promise<RpcResponse>;
  onNotification(handler: (notif: RpcNotification) => void): () => void;
  onClose?(handler: (error: Error) => void): () => void;
}

/**
 * 内存内高效 Transport 实现 (同进程客户端与服务端直连)
 */
export class InMemoryTransport implements Transport {
  private server: InkRpcServer;
  private readonly connectionId = crypto.randomUUID();
  private notifHandlers: Array<(notif: RpcNotification) => void> = [];
  private readonly unregister: () => void;
  private closed = false;

  constructor(server: InkRpcServer) {
    this.server = server;
    this.unregister = this.server.registerDirectConnection(this.connectionId, (notif) => {
      for (const h of this.notifHandlers) {
        h(notif);
      }
    });
  }

  public async sendRequest(req: RpcRequest): Promise<RpcResponse> {
    if (this.closed) throw new Error('RPC in-memory connection is closed');
    return await this.server.handleRequest(req, this.connectionId);
  }

  public onNotification(handler: (notif: RpcNotification) => void): () => void {
    this.notifHandlers.push(handler);
    return () => {
      const idx = this.notifHandlers.indexOf(handler);
      if (idx !== -1) this.notifHandlers.splice(idx, 1);
    };
  }

  public close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unregister();
    this.notifHandlers = [];
  }
}

/**
 * 远程 Transport 实现 (基于 RpcTransport 流通道)
 */
export class RemoteStreamTransport extends RpcStreamRequests implements Transport {}

export class InkRpcClient {
  private readonly connectionClosed = new AbortController();
  private readonly sessions = new RpcSessionAttachment();
  private readonly unsubscribeNotifications: () => void;
  private readonly unsubscribeClose?: () => void;
  private transport: Transport;
  private reqIdCounter = 1;
  private notificationListeners = new Map<string, Array<(params: any) => void>>();

  constructor(transport: Transport) {
    this.transport = transport;
    this.unsubscribeClose = this.transport.onClose?.((error) => this.connectionClosed.abort(error));
    this.unsubscribeNotifications = this.transport.onNotification((notif) => {
      if (this.connectionClosed.signal.aborted || !this.sessions.acceptsNotification(notif.method, notif.route)) return;
      const listeners = this.notificationListeners.get(notif.method);
      if (listeners) {
        for (const l of listeners) {
          try {
            l(notif.params);
          } catch {
            /* One consumer does not own the RPC connection. */
          }
        }
      }
    });
  }

  public static async connectTcp(
    port: number,
    host = DEFAULT_RPC_HOST,
    limits?: Partial<RpcLimits>
  ): Promise<InkRpcClient> {
    const rawTransport = await TcpSocketTransport.connect(port, host, limits);
    const streamTransport = new RemoteStreamTransport(rawTransport, limits);
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

  public async request<T = any>(method: string, params?: any, options: RpcRequestOptions = {}): Promise<T> {
    const attachment = this.sessions.forRequest(method, params);
    const req: RpcRequest = {
      jsonrpc: '2.0',
      id: this.reqIdCounter++,
      method,
      params:
        attachment.route && method !== 'session.fork' ? { ...params, sessionId: attachment.route.sessionId } : params,
      ...(attachment.route ? { route: attachment.route } : {})
    };

    const signal = AbortSignal.any([
      this.connectionClosed.signal,
      ...[options.signal, attachment.signal].filter((value): value is AbortSignal => value !== undefined)
    ]);
    signal.throwIfAborted();
    const res = await awaitWithAbort(this.transport.sendRequest(req, { ...options, signal }), signal);
    if (attachment.route && !sameSessionAttachment(attachment.route, res.route))
      throw new Error('RPC response belongs to another session attachment');
    if (res.error) {
      throw new Error(`[RPC ${res.error.code}] ${res.error.message}`);
    }
    return res.result as T;
  }

  public async attachSession(sessionId: string, options: RpcRequestOptions = {}): Promise<SessionAttachment> {
    const attempt = this.sessions.beginAttach();
    const signal = options.signal ? AbortSignal.any([options.signal, attempt.signal]) : attempt.signal;
    const route = await this.request<SessionAttachment>(
      'session.attach',
      { sessionId, generation: attempt.generation },
      { ...options, signal }
    );
    return this.sessions.accept(attempt.generation, sessionId, route);
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
      return this.request<{ text: string }>('editor.insertText', {
        text: posOrText
      });
    }
    return this.request<{ text: string }>('editor.insertText', {
      pos: posOrText,
      text: text || ''
    });
  }

  public replaceEditorRange(start: number, end: number, text: string) {
    return this.request<{ text: string }>('editor.replaceRange', {
      start,
      end,
      text
    });
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
    return this.request<{ suggestion?: string }>('ghost.suggest', {
      suggestion
    });
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
    return this.request<{ handled: boolean; output: string }>('slash.execute', {
      command
    });
  }

  public executeSlash(command: string) {
    return this.request<{ handled: boolean; output: string }>('slash.execute', {
      command
    });
  }

  // 6. Journal
  public appendJournal(type: string, payload: any, id?: string) {
    return this.request<{ id: string }>('journal.append', {
      type,
      payload,
      id
    });
  }

  public getJournalEntries() {
    return this.request<any[]>('journal.getEntries');
  }

  // 7. JIT Memory
  public retrieveJitMemory(params: any) {
    return this.request<any>('jit.retrieve', params);
  }

  // 8. FTS
  public searchFts(query: string, workspaceId: string, limit?: number) {
    return this.request<any[]>('storage.searchFts', { query, workspaceId, limit });
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

  public getRuntimeDiagnostics(): Promise<DiagnosticSnapshot> {
    return this.request<DiagnosticSnapshot>('runtime.diagnostics');
  }

  public submitTask(task: AiTask, requestId?: string): Promise<TaskSubmitResult> {
    return this.request<TaskSubmitResult>('task.submit', { task, ...(requestId === undefined ? {} : { requestId }) });
  }

  public getTaskAdmission(requestId: string): Promise<TaskAdmissionReceipt | null> {
    return this.request<TaskAdmissionReceipt | null>('task.admission', { requestId });
  }

  public cancelTask(taskId: string): Promise<TaskCancelResult> {
    return this.request<TaskCancelResult>('task.cancel', { taskId });
  }

  public getTaskStatus(taskId: string): Promise<TaskStatusSnapshot> {
    return this.request<TaskStatusSnapshot>('task.status', { taskId });
  }

  public getTaskExecution(taskId: string): Promise<TaskExecutionSnapshot> {
    const params: TaskExecutionParams = { taskId };
    return this.request<TaskExecutionSnapshot>('task.execution', params);
  }

  public getCacheStatus(): Promise<CacheStatus> {
    return this.request<CacheStatus>('cache.status');
  }

  public invalidateCache(params: CacheInvalidateParams): Promise<CacheInvalidateResult> {
    return this.request<CacheInvalidateResult>('cache.invalidate', params);
  }

  public steerTask(taskId: string, input: unknown): Promise<TaskSteerResult> {
    const params: TaskSteerParams = { taskId, input };
    return this.request<TaskSteerResult>('task.steer', params);
  }

  public resumeTask(taskId: string): Promise<TaskSubmitResult> {
    const params: TaskResumeParams = { taskId };
    return this.request<TaskSubmitResult>('task.resume', params);
  }

  public replayTask(taskId: string, replayTaskId?: string): Promise<TaskSubmitResult> {
    const params: TaskReplayParams = { taskId, replayTaskId };
    return this.request<TaskSubmitResult>('task.replay', params);
  }

  public forkTask(taskId: string, forkTaskId: string, patch?: Partial<AiTask>): Promise<TaskSubmitResult> {
    const params: TaskForkParams = { taskId, forkTaskId, patch };
    return this.request<TaskSubmitResult>('task.fork', params);
  }

  public waitForTask(taskId: string, signal?: AbortSignal): Promise<TaskResult> {
    return observeTaskResult(
      taskId,
      () => this.getTaskStatus(taskId),
      (listener) =>
        this.on('task.event', (event: { taskId: string; snapshot: TaskStatusSnapshot }) => {
          if (event.taskId === taskId) listener(event.snapshot);
        }),
      signal ? AbortSignal.any([signal, this.connectionClosed.signal]) : this.connectionClosed.signal
    );
  }

  public pushDomainChangeSet(changeSet: DomainChangeSet): Promise<DomainProjectionApplyResult> {
    return this.request<DomainProjectionApplyResult>('domain.sync.push', {
      changeSet
    });
  }

  public pullDomainChangeSets(workspaceId: string, afterRevision = 0): Promise<DomainChangeSet[]> {
    return this.request<DomainChangeSet[]>('domain.sync.pull', {
      workspaceId,
      afterRevision
    });
  }

  public snapshotDomain(workspaceId: string): Promise<DomainProjectionSnapshot> {
    return this.request<DomainProjectionSnapshot>('domain.sync.snapshot', {
      workspaceId
    });
  }

  public pullDomainChangePage(params: DomainSyncPageParams): Promise<DomainSyncPage> {
    return this.request<DomainSyncPage>('domain.sync.page', { ...params });
  }

  public watchDomain(workspaceId: string, options?: DomainWatchOptions): AsyncIterableIterator<DomainWatchEvent> {
    return watchDomainChanges(this, workspaceId, options);
  }

  public restoreDomainSnapshot(
    snapshot: DomainProjectionSnapshot
  ): Promise<{ workspaceId: string; revision: number; updatedAt: number }> {
    return this.request('domain.sync.restore', { snapshot });
  }

  public pushProposalState(
    workspaceId: string,
    expectedRevision: number,
    proposal: ProposalProjectionState
  ): Promise<ProposalSyncPushResult> {
    return this.request<ProposalSyncPushResult>('proposal.sync.push', {
      workspaceId,
      expectedRevision,
      proposal,
      stateHash: calculateProposalProjectionStateHash(proposal)
    });
  }

  public snapshotProposals(workspaceId: string): Promise<ProposalProjectionSnapshot> {
    return this.request<ProposalProjectionSnapshot>('proposal.sync.snapshot', {
      workspaceId
    });
  }

  public saveArtifact(artifact: Artifact): Promise<ArtifactSaveResult> {
    const params: ArtifactSaveParams = { artifact };
    return this.request('artifact.save', params);
  }

  public async getArtifact(id: string): Promise<Artifact | undefined> {
    const params: ArtifactGetParams = { id };
    const artifact = await this.request<Artifact | null>('artifact.get', params);
    return artifact ?? undefined;
  }

  public listArtifacts(options: ArtifactListParams = {}): Promise<Artifact[]> {
    return this.request('artifact.list', options);
  }

  public purgeWorkspace(workspaceId: string): Promise<{
    success: boolean;
    workspaceId: string;
    purgedRecords: Record<string, number>;
  }> {
    return this.request('workspace.purge', { workspaceId });
  }

  public onNotification(handler: (notif: RpcNotification) => void): () => void {
    return this.transport.onNotification((notif) => {
      if (!this.connectionClosed.signal.aborted && this.sessions.acceptsNotification(notif.method, notif.route))
        handler(notif);
    });
  }

  public async close(): Promise<void> {
    this.connectionClosed.abort(new Error('RPC client connection closed'));
    this.sessions.close();
    this.unsubscribeNotifications();
    this.unsubscribeClose?.();
    this.notificationListeners.clear();
    if ((this.transport as any).close) {
      await (this.transport as any).close();
    }
  }
}
