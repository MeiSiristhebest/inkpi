import { GhostTextManager, HeadlessEditorState } from '@inkpi/editor-core';
import { Agent } from '../agent.js';

import { getModelPreset } from '@inkpi/ai';
import type { ModelConfig, SessionCreateOptions, SessionEntry, SessionSummary } from '@inkpi/protocol';
import { NoModelConfiguredError } from '../errors.js';
import type { Clock, SessionStore } from '../ports/index.js';
import { restoreProviderSessionId } from '../provider-session.js';
import {
  detectAndMarkInterruptedOperations,
  planInterruptedRecovery,
  reduceSession,
  synthesizeInterruptedToolResult
} from '../reducer/session-reducer.js';
import { SessionTree } from '../tree.js';
import type { AgentOptions } from '../types.js';

export interface ManagedSession {
  sessionId: string;
  agent: Agent;
  editor: HeadlessEditorState;
  ghost: GhostTextManager;
  tree: SessionTree;
  createdAt: number;
  lastActiveAt: number;
  metadata?: Record<string, unknown>;
}

// The session wire contract lives in @inkpi/protocol so the daemon's RPC map can name it;
// re-exported here because agent-core publishes its session surface from this module.
export type { SessionCreateOptions, SessionSummary } from '@inkpi/protocol';

export interface SessionRegistryOptions {
  journalFactory?: (sessionId: string, entries?: readonly SessionEntry[]) => AgentOptions['journal'];
  providerSessionIdGenerator?: () => string;
}

/**
 * 实时多会话注册表 (SessionRegistry)
 * 多会话注册表：支持多 Client 并发挂载不同活跃 Session，实现 SessionStore 端口。
 */
export class SessionRegistry implements SessionStore {
  private sessions = new Map<string, ManagedSession>();
  private defaultModel?: ModelConfig;
  private clock: Clock;

  private idGenerator?: () => string;

  constructor(
    clock: Clock,
    defaultModel?: ModelConfig,
    idGenerator?: () => string,
    private readonly options: SessionRegistryOptions = {}
  ) {
    // 注意：不再静默回落到假模型。defaultModel 可选，但当会话既未显式指定模型、
    // 管理器也无默认模型时，createSession 会抛出明确的错误。
    this.defaultModel = defaultModel;
    this.clock = clock;
    this.idGenerator = idGenerator;
  }

  public createSession(options: SessionCreateOptions = {}): ManagedSession {
    const sessionId = options.sessionId || (this.idGenerator ? this.idGenerator() : `sess_${crypto.randomUUID()}`);
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    const requestedModel = typeof options.model === 'string' ? getModelPreset(options.model) : options.model;

    const resolvedModel = requestedModel || this.defaultModel;
    if (!resolvedModel) {
      throw new NoModelConfiguredError();
    }

    const journal = this.options.journalFactory?.(sessionId, options.entries);
    const entries: SessionEntry[] = journal?.getEntries?.() ?? options.entries ?? [];
    const restored = reduceSession(entries);
    const agent = new Agent({
      clock: this.clock,
      sessionId,
      journal,
      providerSessionId: restoreProviderSessionId(entries),
      providerSessionIdGenerator: this.options.providerSessionIdGenerator,
      initialState: {
        model: resolvedModel,
        systemPrompt:
          options.systemPrompt ??
          (entries.some((entry) => entry.type === 'model_loadout')
            ? undefined
            : 'You are an expert creative AI co-writer and assistant.'),
        messages: journal ? undefined : restored.messages
      }
    });

    const editor = new HeadlessEditorState(options.initialText || '');
    const ghost = new GhostTextManager(editor);
    const tree = new SessionTree(undefined, { clock: this.clock });

    if (entries.length > 0) {
      const messages = new Map(restored.messages.map((message) => [message.id, message]));
      const messageParent = new Map<string, string | null>();
      for (const entry of entries) {
        const parent = entry.parentId ? (messageParent.get(entry.parentId) ?? null) : null;
        const message = messages.get(entry.id);
        if (message) tree.addMessage(message, parent);
        messageParent.set(entry.id, message ? entry.id : parent);
      }

      // 恢复语义（对齐上游 pi tool-durability "unsafe orphan synthesis"）：
      // 无日志时只能提供未重跑的占位视图。可读日志的恢复由 Agent 执行，
      // 在继续请求前验证当前工具契约并原子提交 settlement 与结果。
      const recovered = detectAndMarkInterruptedOperations(
        journal ? reduceSession(agent.getConversationPath()) : restored,
        this.clock
      );
      for (const plan of journal ? [] : planInterruptedRecovery(recovered.state, agent.getToolRegistry())) {
        if (plan.action !== 'synthesize') continue;
        const synthetic = synthesizeInterruptedToolResult(plan, this.clock);
        agent.state.messages.push(synthetic);
        tree.addMessage(synthetic);
      }
    }

    const managed: ManagedSession = {
      sessionId,
      agent,
      editor,
      ghost,
      tree,
      createdAt: this.clock(),
      lastActiveAt: this.clock(),
      metadata: options.metadata
    };

    this.sessions.set(sessionId, managed);
    return managed;
  }

  public forkSession(sourceSessionId: string, options: SessionCreateOptions = {}): ManagedSession {
    const source = this.sessions.get(sourceSessionId);
    if (!source) throw new Error(`Session '${sourceSessionId}' not found.`);
    if (!source.agent.isIdle) throw new Error('Wait for the source session to become idle before forking.');
    if (options.sessionId && this.sessions.has(options.sessionId)) throw new Error('Fork requires a new sessionId.');
    const messages = structuredClone(source.agent.state.messages);
    const path = source.agent.getConversationPath().filter((entry) => entry.type !== 'provider_session');
    const entries: SessionEntry[] = path.length
      ? path.map((entry, index) => ({
          ...entry,
          sessionId: options.sessionId ?? '',
          seq: index + 1,
          parentId: index > 0 ? path[index - 1].id : null
        }))
      : messages.map((message, index) => ({
          id: message.id ?? `fork_message_${index + 1}`,
          sessionId: options.sessionId ?? '',
          seq: index + 1,
          parentId: index > 0 ? (messages[index - 1].id ?? `fork_message_${index}`) : null,
          timestamp: message.timestamp ?? this.clock(),
          type:
            message.role === 'user'
              ? 'user_message'
              : message.role === 'assistant'
                ? 'agent_turn'
                : message.role === 'toolResult'
                  ? 'tool_execution'
                  : 'custom',
          payload: message
        }));
    return this.createSession({
      ...options,
      model: options.model ?? source.agent.state.model,
      systemPrompt: options.systemPrompt ?? source.agent.state.systemPrompt,
      initialText: options.initialText ?? source.editor.getText(),
      entries
    });
  }

  public getSession(sessionId: string): ManagedSession | undefined {
    // 纯读：不再在 getter 中改写 lastActiveAt，避免读取操作产生副作用。
    return this.sessions.get(sessionId);
  }

  public getOrCreateSession(sessionId?: string, options?: SessionCreateOptions): ManagedSession {
    if (sessionId && this.sessions.has(sessionId)) {
      return this.getSession(sessionId)!;
    }
    return this.createSession({ ...options, sessionId });
  }

  public closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.agent.abort();
      return this.sessions.delete(sessionId);
    }
    return false;
  }

  public listSessions(): SessionSummary[] {
    const list: SessionSummary[] = [];
    for (const s of this.sessions.values()) {
      list.push({
        sessionId: s.sessionId,
        createdAt: s.createdAt,
        lastActiveAt: s.lastActiveAt,
        messageCount: s.agent.state.messages.length,
        documentLength: s.editor.getText().length,
        hasGhostText: s.ghost.hasGhostText(),
        metadata: s.metadata
      });
    }
    return list;
  }

  public clear(): void {
    for (const s of this.sessions.values()) {
      s.agent.abort();
    }
    this.sessions.clear();
  }

  public get size(): number {
    return this.sessions.size;
  }
}
