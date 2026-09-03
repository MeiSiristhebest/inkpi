import { GhostTextManager, HeadlessEditorState } from '@inkpi/editor-core';
import { Agent } from '../agent.js';

import { getModelPreset } from '@inkpi/ai';
import type { ModelConfig } from '@inkpi/protocol';
import { NoModelConfiguredError } from '../errors.js';
import type { Clock, SessionStore } from '../ports/index.js';
import { SessionTree } from '../tree.js';

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

export interface SessionCreateOptions {
  sessionId?: string;
  model?: ModelConfig | string;
  initialText?: string;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
}

export interface SessionSummary {
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  documentLength: number;
  hasGhostText: boolean;
  metadata?: Record<string, unknown>;
}

/**
 * 实时多会话注册表 (SessionRegistry)
 * 多会话注册表：支持多 Client 并发挂载不同活跃 Session，实现 SessionStore 端口。
 */
export class SessionRegistry implements SessionStore {
  private sessions = new Map<string, ManagedSession>();
  private defaultModel?: ModelConfig;
  private clock: Clock;

  constructor(clock: Clock, defaultModel?: ModelConfig) {
    // 注意：不再静默回落到假模型。defaultModel 可选，但当会话既未显式指定模型、
    // 管理器也无默认模型时，createSession 会抛出明确的错误。
    this.defaultModel = defaultModel;
    this.clock = clock;
  }

  public createSession(options: SessionCreateOptions = {}): ManagedSession {
    const sessionId = options.sessionId || `sess_${this.clock()}_${Math.random().toString(36).slice(2, 7)}`;
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    const requestedModel = typeof options.model === 'string' ? getModelPreset(options.model) : options.model;

    const resolvedModel = requestedModel || this.defaultModel;
    if (!resolvedModel) {
      throw new NoModelConfiguredError();
    }

    const agent = new Agent({
      initialState: {
        model: resolvedModel,
        systemPrompt: options.systemPrompt || 'You are an expert creative AI co-writer and assistant.'
      }
    });

    const editor = new HeadlessEditorState(options.initialText || '');
    const ghost = new GhostTextManager(editor);
    const tree = new SessionTree();

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
