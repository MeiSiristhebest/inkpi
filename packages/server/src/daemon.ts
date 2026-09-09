import type * as net from 'node:net';
import {
  type ManagedSession,
  REAL_CLOCK,
  type SessionCreateOptions,
  SessionRegistry,
  ContextPipeline,
  InstructionRegistry,
  RuntimeCacheCoordinator,
  TaskRouter,
  TaskObservability,
  ProgressiveSkillRuntime,
  type RuntimeCacheCoordinatorPort,
  type TaskObservabilityOptions,
  type TaskRunObserver,
  type ProgressiveSkillRuntimeOptions,
  type InstructionDefinition,
  type InstructionEntry,
} from '@inkpi/agent-core';
import type {
  Artifact,
  ArtifactGetParams,
  ArtifactListParams,
  ArtifactSaveParams,
  ArtifactSaveResult,
  DomainSyncPullParams,
  DomainSyncPushParams,
  DomainSyncRestoreParams,
  DomainSyncSnapshotParams,
  InstructionListParams,
  InstructionRegisterParams,
  InstructionRegisterResult,
  InstructionRegistrationStatus,
  InstructionRegistryStatus,
  ModelConfig,
  ProposalSyncPushParams,
  ProposalSyncSnapshotParams,
  TaskCancelParams,
  TaskExecutionParams,
  TaskExecutionSnapshot,
  TaskForkParams,
  TaskReplayParams,
  TaskResumeParams,
  TaskStatusParams,
  TaskSteerParams,
  TaskSubmitParams,
  SkillActivateParams,
  SkillActivationResult,
  SkillDiscoverResult,
  SkillLoadParams,
  SkillLoadResult,
  SkillResolveQuery,
  SkillResolveResult,
} from '@inkpi/protocol';
import { InkRpcServer, type ServerContext } from './server.js';
import { TcpSocketTransport } from './tcp-transport.js';
import type { RpcTransport } from './transport.js';
import { DEFAULT_RPC_HOST, DEFAULT_RPC_PORT } from './transport.js';
import { TaskModelHandler } from './task-model-handler.js';
import { JitContextProvider } from './jit-context-provider.js';
import type { ProposalProjectionStore } from '@inkpi/storage';
import type {
  CapabilityRouter,
  ModelCapabilities,
  ModelRoute,
} from './model-capability-router.js';
import { createSerializedCreativeContextProviders } from './serialized-creative-context-provider.js';

export interface DaemonOptions {
  port?: number;
  host?: string;
  wsPort?: number;
  defaultModel?: ModelConfig;
  defaultModelCapabilities?: ModelCapabilities;
  modelRoutes?: readonly ModelRoute[];
  capabilityRouter?: CapabilityRouter;
  instructionRegistry?: InstructionRegistry;
  skillRuntime?: ProgressiveSkillRuntime;
  skillSearchDirs?: readonly string[];
  skillActivators?: ProgressiveSkillRuntimeOptions['skillActivators'];
  observer?: TaskRunObserver;
  observability?: TaskObservabilityOptions;
  cacheCoordinator?: RuntimeCacheCoordinatorPort;
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
  private taskRouter: TaskRouter;
  private startTime = 0;
  private running = false;
  private tcpServer: net.Server | null = null;
  private wsPort: number | null = null;
  private options: DaemonOptions;
  private readonly instructionRegistry: InstructionRegistry;
  private readonly skillRuntime: ProgressiveSkillRuntime;
  private readonly capabilityRouter?: CapabilityRouter;
  private readonly taskObservability: TaskObservability;
  private readonly cacheCoordinator: RuntimeCacheCoordinatorPort;

  constructor(options: DaemonOptions = {}) {
    this.options = {
      port: DEFAULT_RPC_PORT,
      host: DEFAULT_RPC_HOST,
      ...options
    };
    this.cacheCoordinator = options.cacheCoordinator ?? new RuntimeCacheCoordinator();
    this.taskObservability = new TaskObservability(options.observability);
    this.sessionManager = new SessionRegistry(REAL_CLOCK, options.defaultModel);
    this.instructionRegistry =
      options.instructionRegistry ?? options.context?.instructionRegistry ?? new InstructionRegistry();
    const contextPipeline =
      options.context?.taskRouter?.contextPipeline ??
      options.context?.contextPipeline ??
      new ContextPipeline({ cacheCoordinator: this.cacheCoordinator });
    const contextProviders = [
      ...(options.context?.contextProviders ?? []),
      ...createSerializedCreativeContextProviders(),
    ];
    for (const provider of contextProviders) {
      if (!contextPipeline.list().some((registered) => registered.id === provider.id)) {
        contextPipeline.register(provider);
      }
    }
    if (
      options.context?.jitRetriever &&
      !contextPipeline.list().some((provider) => provider.id === 'retrieval.jit')
    ) {
      contextPipeline.register(
        new JitContextProvider(options.context.jitRetriever, { cacheCoordinator: this.cacheCoordinator })
      );
    }
    this.taskRouter = options.context?.taskRouter ?? new TaskRouter({
      checkpointStore: options.context?.checkpointStore,
      executionStore: options.context?.executionStore,
      contextPipeline,
      instructionRegistry: this.instructionRegistry,
      observer: options.observer ?? this.taskObservability,
      cacheCoordinator: this.cacheCoordinator,
    });
    if (
      (options.defaultModel || options.modelRoutes?.length || options.capabilityRouter) &&
      !this.taskRouter.registry.list().some((handler) => handler.id === 'runtime.model')
    ) {
      const modelHandler = new TaskModelHandler({
        model: options.defaultModel,
        defaultModelCapabilities: options.defaultModelCapabilities,
        routes: options.modelRoutes,
        capabilityRouter: options.capabilityRouter,
        cacheCoordinator: this.cacheCoordinator,
      });
      this.capabilityRouter = modelHandler.getCapabilityRouter();
      this.taskRouter.registry.register(modelHandler);
    } else {
      this.capabilityRouter = options.capabilityRouter;
    }
    this.skillRuntime = options.skillRuntime ?? new ProgressiveSkillRuntime({
      searchDirs: options.skillSearchDirs ? [...options.skillSearchDirs] : undefined,
      extensionHost: options.context?.extensionHost,
      toolRegistry: this.taskRouter.toolRegistry,
      taskRegistry: this.taskRouter.registry,
      contextPipeline: this.taskRouter.contextPipeline,
      instructionRegistry: this.instructionRegistry,
      skillActivators: options.skillActivators
    });
    if (this.skillRuntime.toolRegistry !== this.taskRouter.toolRegistry) {
      throw new Error('Daemon skill runtime must use the TaskRouter ToolRegistry');
    }
    if (this.skillRuntime.taskRegistry && this.skillRuntime.taskRegistry !== this.taskRouter.registry) {
      throw new Error('Daemon skill runtime must use the TaskRouter TaskRegistry');
    }
    if (this.skillRuntime.contextPipeline && this.skillRuntime.contextPipeline !== this.taskRouter.contextPipeline) {
      throw new Error('Daemon skill runtime must use the TaskRouter ContextPipeline');
    }
    this.rpcServer = new InkRpcServer({
      ...options.context,
      taskRouter: this.taskRouter,
      instructionRegistry: this.instructionRegistry,
      extensionHost: this.skillRuntime.extensionHost,
      skillRuntime: this.skillRuntime,
    } as ServerContext);
    this.taskRouter.subscribe((event) => {
      this.rpcServer.notify('task.event', event);
    });
    this.registerDaemonMethods();
  }

  public getSessionManager(): SessionRegistry {
    return this.sessionManager;
  }

  public getRpcServer(): InkRpcServer {
    return this.rpcServer;
  }

  public getTaskRouter(): TaskRouter {
    return this.taskRouter;
  }

  /** The default task observer used by the daemon-owned TaskRouter. */
  public getTaskObservability(): TaskObservability {
    return this.taskObservability;
  }

  /** Shared metrics bridge for the provider, context, and retrieval caches. */
  public getCacheCoordinator(): RuntimeCacheCoordinatorPort {
    return this.cacheCoordinator;
  }

  /** The registry used by the daemon-owned TaskRouter and instruction RPCs. */
  public getInstructionRegistry(): InstructionRegistry {
    return this.instructionRegistry;
  }

  /** The single ProgressiveSkillRuntime shared with the daemon's registries. */
  public getSkillRuntime(): ProgressiveSkillRuntime {
    return this.skillRuntime;
  }

  /** 返回守护进程实际监听的 TCP 端口（端口 0 时由操作系统分配）。 */
  public getPort(): number {
    return this.options.port ?? 0;
  }

  private registerDaemonMethods(): void {
    this.rpcServer.registerMethod('domain.sync.push', (params: DomainSyncPushParams) => {
      return this.withDomainProjection().apply(params.changeSet);
    });

    this.rpcServer.registerMethod('domain.sync.pull', (params: DomainSyncPullParams) => {
      return this.withDomainProjection().list(params.workspaceId, params.afterRevision);
    });

    this.rpcServer.registerMethod('domain.sync.snapshot', (params: DomainSyncSnapshotParams) => {
      return this.withDomainProjection().createSnapshot(params.workspaceId);
    });

    this.rpcServer.registerMethod('domain.sync.restore', (params: DomainSyncRestoreParams) => {
      return this.withDomainProjection().restoreSnapshot(params.snapshot);
    });

    this.rpcServer.registerMethod('proposal.sync.push', (params: ProposalSyncPushParams) => {
      return this.withProposalProjection().apply(params);
    });

    this.rpcServer.registerMethod('proposal.sync.snapshot', (params: ProposalSyncSnapshotParams) => {
      return this.withProposalProjection().snapshot(params.workspaceId);
    });

    this.rpcServer.registerMethod('artifact.save', async (params: ArtifactSaveParams): Promise<ArtifactSaveResult> => {
      await this.withArtifactStore().save(params.artifact);
      return { saved: true, id: params.artifact.id };
    });

    this.rpcServer.registerMethod('artifact.get', (params: ArtifactGetParams) => {
      return this.withArtifactStore().get(params.id);
    });

    this.rpcServer.registerMethod(
      'artifact.list',
      async (params: ArtifactListParams = {}) => {
        const store = this.withArtifactStore();
        if (params.type && !params.taskId && store.listByType) return store.listByType(params.type);
        const artifacts = await store.list(params.taskId);
        return params.type ? artifacts.filter((artifact) => artifact.type === params.type) : artifacts;
      }
    );

    const discoverSkills = (): SkillDiscoverResult => this.skillRuntime.discoverManifests();
    this.rpcServer.registerMethod('skill.discover', discoverSkills);
    // A short alias keeps the catalog operation easy to discover for clients.
    this.rpcServer.registerMethod('skill.list', discoverSkills);
    this.rpcServer.registerMethod(
      'skill.resolve',
      (params: SkillResolveQuery = {}): SkillResolveResult => this.skillRuntime.resolve(params)
    );
    this.rpcServer.registerMethod('skill.load', (params: SkillLoadParams): SkillLoadResult => {
      const skillId = requiredSkillId(params);
      this.skillRuntime.load(skillId);
      return {
        loaded: true,
        skill: this.skillRuntime.getManifest(skillId),
        snapshot: this.skillRuntime.getRegistrationSnapshot()
      };
    });
    this.rpcServer.registerMethod('skill.activate', async (params: SkillActivateParams): Promise<SkillActivationResult> => {
      const skillId = requiredSkillId(params);
      await this.skillRuntime.activate(skillId);
      return {
        activated: true,
        loaded: true,
        skill: this.skillRuntime.getManifest(skillId),
        snapshot: this.skillRuntime.getRegistrationSnapshot()
      };
    });
    const skillStatus = () => this.skillRuntime.getRegistrationSnapshot();
    this.rpcServer.registerMethod('skill.status', skillStatus);
    this.rpcServer.registerMethod('skill.snapshot', skillStatus);

    this.rpcServer.registerMethod('instruction.register', (params: unknown) => {
      return this.registerInstructions(params);
    });

    this.rpcServer.registerMethod('instruction.list', (params: InstructionListParams = {}) => {
      const entries = this.instructionRegistry.list();
      if (!params.taskKind) return entries;
      return entries.filter((entry) => entry.tags?.includes(`task:${params.taskKind}`));
    });

    this.rpcServer.registerMethod('instruction.status', () => {
      const entries = this.instructionRegistry.list();
      return {
        ready: true,
        version: this.instructionRegistry.version(),
        count: entries.length,
        instructionIds: entries.map((entry) => entry.id),
        instructions: this.instructionRegistry.listReferences(),
      } satisfies InstructionRegistryStatus;
    });

    this.rpcServer.registerMethod('task.submit', (params: TaskSubmitParams) => {
      this.capabilityRouter?.resolve(params.task);
      return this.taskRouter.submit(params.task);
    });

    this.rpcServer.registerMethod('task.cancel', (params: TaskCancelParams) => {
      return this.taskRouter.cancel(params.taskId);
    });

    this.rpcServer.registerMethod('task.status', (params: TaskStatusParams) => {
      return this.taskRouter.status(params.taskId);
    });

    this.rpcServer.registerMethod('task.execution', async (params: TaskExecutionParams): Promise<TaskExecutionSnapshot> => {
      await this.taskRouter.ready;
      return this.taskRouter.execution(params.taskId);
    });

    this.rpcServer.registerMethod('task.steer', (params: TaskSteerParams) => {
      return this.taskRouter.steer(params.taskId, params.input);
    });

    this.rpcServer.registerMethod('task.resume', (params: TaskResumeParams) => {
      return this.taskRouter.resume(params.taskId);
    });

    this.rpcServer.registerMethod('task.replay', (params: TaskReplayParams) => {
      return this.taskRouter.replay(params.taskId, params.replayTaskId);
    });

    this.rpcServer.registerMethod('task.fork', (params: TaskForkParams) => {
      return this.taskRouter.fork(params.taskId, params.forkTaskId, params.patch);
    });

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
    this.rpcServer.registerMethod(
      'session.editor.insert',
      (params: { sessionId: string; pos: number; text: string }) => {
        const session = this.withSession(params?.sessionId);
        session.editor.insertText(params.pos, params.text);
        return { text: session.editor.getText(), version: session.editor.getVersion() };
      }
    );

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

    this.rpcServer.registerMethod(
      'session.ghost.suggest',
      (params: { sessionId: string; text: string; pos?: number }) => {
        const session = this.withSession(params?.sessionId);
        const suggestion = session.ghost.suggest(params.text, params.pos);
        return suggestion;
      }
    );

    this.rpcServer.registerMethod(
      'session.ghost.accept',
      (params: { sessionId: string; mode?: 'all' | 'word' | 'line' }) => {
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
      }
    );

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

  private withDomainProjection() {
    const projection = (this.options.context as ServerContext | undefined)?.domainProjection;
    if (!projection) throw new Error('Domain projection storage is not configured');
    return projection;
  }

  private withProposalProjection(): ProposalProjectionStore {
    const projection = (this.options.context as ServerContext | undefined)?.proposalProjection;
    if (!projection) throw new Error('Proposal projection storage is not configured');
    return projection;
  }

  private withArtifactStore() {
    const store = (this.options.context as ServerContext | undefined)?.artifactStore;
    if (!store) throw new Error('Artifact storage is not configured');
    return store;
  }

  private registerInstructions(params: unknown): InstructionRegisterResult {
    const definitions = normalizeInstructionDefinitions(params);
    const added: string[] = [];
    const updated: string[] = [];
    const unchanged: string[] = [];
    const results: InstructionRegistrationStatus[] = [];

    for (const definition of definitions) {
      const entry = instructionEntry(definition);
      const existing = this.instructionRegistry.list().find((candidate) => candidate.id === entry.id);
      if (!existing) {
        this.instructionRegistry.register(entry);
        added.push(entry.id);
        results.push({ id: entry.id, version: definition.version, status: 'added' });
        continue;
      }

      if (sameInstruction(existing, entry)) {
        unchanged.push(entry.id);
        results.push({ id: entry.id, version: definition.version, status: 'unchanged' });
        continue;
      }

      this.instructionRegistry.upsert(entry);
      updated.push(entry.id);
      results.push({ id: entry.id, version: definition.version, status: 'updated' });
    }

    return {
      success: true,
      registered: true,
      count: definitions.length,
      instructionIds: definitions.map((definition) => definition.id),
      added,
      updated,
      unchanged,
      results,
      version: this.instructionRegistry.version(),
    };
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
   * 额外开启 WebSocket 监听 (浏览器 / Tauri WebView GUI 客户端入口)。
   * 默认端口：`options.wsPort`（可注入）→ 否则退回约定 `TCP 端口 + 1`。
   */
  public async startWebSocket(
    wsPort = this.options.wsPort ?? (this.options.port ?? DEFAULT_RPC_PORT) + 1,
    host = this.options.host
  ): Promise<this> {
    this.wsPort = wsPort;
    this.options.wsPort = wsPort;
    await this.rpcServer.listenWebSocket(wsPort!, host!);
    return this;
  }

  public attachTransport(transport: RpcTransport): void {
    this.rpcServer.bindTransport(transport);
  }

  public async stop(): Promise<void> {
    if (!this.running) {
      await this.taskRouter.stop();
      return;
    }
    this.running = false;
    await this.taskRouter.stop();
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

function normalizeInstructionDefinitions(params: unknown): InstructionDefinition[] {
  const rawDefinitions = Array.isArray(params)
    ? params
    : isRecord(params) && Array.isArray(params.instructions)
      ? params.instructions
      : isRecord(params) && params.instruction !== undefined
        ? [params.instruction]
        : isRecord(params)
          ? [params]
          : [];
  if (rawDefinitions.length === 0) {
    throw new Error('instruction.register requires an instruction or instructions array');
  }
  return rawDefinitions.map((raw) => normalizeInstructionDefinition(raw));
}

function normalizeInstructionDefinition(raw: unknown): InstructionDefinition {
  if (!isRecord(raw)) throw new Error('Instruction definition must be an object');
  const id = requiredString(raw.id, 'id');
  const version = requiredString(raw.version, 'version');
  const systemInstruction = requiredString(raw.systemInstruction, 'systemInstruction');
  const taskKind = typeof raw.taskKind === 'string' && raw.taskKind.trim().length > 0
    ? raw.taskKind.trim()
    : inferTaskKind(id);
  return { id, version, taskKind, systemInstruction };
}

function instructionEntry(definition: InstructionDefinition): InstructionEntry {
  return {
    id: definition.id,
    scope: 'task',
    content: definition.systemInstruction,
    version: definition.version,
    source: `task:${definition.taskKind}`,
    tags: [`task:${definition.taskKind}`],
  };
}

function sameInstruction(left: InstructionEntry, right: InstructionEntry): boolean {
  return left.scope === right.scope
    && left.content === right.content
    && left.version === right.version
    && right.tags?.every((tag) => left.tags?.includes(tag)) === true;
}

function inferTaskKind(id: string): string {
  const versionSeparator = id.lastIndexOf(':');
  return versionSeparator > 0 ? id.slice(0, versionSeparator) : id;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Instruction ${field} must be a non-empty string`);
  }
  return value.trim();
}

function requiredSkillId(params: { skillId?: unknown } | null | undefined): string {
  return requiredString(params?.skillId, 'skillId');
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
