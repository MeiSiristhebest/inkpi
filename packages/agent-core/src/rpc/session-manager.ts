import { Agent } from '../agent.js';
import { HeadlessEditorState, GhostTextManager } from '@meisiristhebest/editor-core';

import { SessionTree } from '../tree.js';
import type { ModelConfig } from '@meisiristhebest/protocol';
import { getModelPreset } from '@meisiristhebest/ai';

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
 * 实时多会话管理器 (LiveSessionManager)
 * 1:1 对标 pi-server 的 LiveSessionManager，支持多 Client 并发挂载不同创作 Session
 */
export class LiveSessionManager {
  private sessions = new Map<string, ManagedSession>();
  private defaultModel: ModelConfig;

  constructor(defaultModel?: ModelConfig) {
    this.defaultModel = defaultModel || getModelPreset('mock-test');
  }

  public createSession(options: SessionCreateOptions = {}): ManagedSession {
    const sessionId = options.sessionId || `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    if (this.sessions.has(sessionId)) {
      return this.sessions.get(sessionId)!;
    }

    const model = typeof options.model === 'string'
      ? getModelPreset(options.model)
      : (options.model || this.defaultModel);

    const agent = new Agent({
      initialState: {
        model,
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
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      metadata: options.metadata
    };

    this.sessions.set(sessionId, managed);
    return managed;
  }

  public getSession(sessionId: string): ManagedSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActiveAt = Date.now();
    }
    return session;
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
