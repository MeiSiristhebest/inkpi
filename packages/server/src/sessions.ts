import { HeadlessEditorState, GhostTextManager } from '@inkpi/editor-core';
import type { ModelConfig, AgentMessage } from '@inkpi/protocol';
import { getModelPreset } from '@inkpi/ai';
import type { ISessionBackend } from '@inkpi/session-backends';
import { MemorySessionBackend } from '@inkpi/session-backends';
import type { ManagedSession } from './types.js';

export interface CreateSessionOptions {
  model?: string | ModelConfig;
  initialText?: string;
  backend?: ISessionBackend;
}

/**
 * 活跃会话多路生命周期管理器 (LiveSessionManager)
 * 1:1 对标 repos/pi packages/server session-manager
 */
export class LiveSessionManager {
  private sessions = new Map<string, ManagedSession>();
  private defaultBackendFactory: () => ISessionBackend;

  constructor(defaultBackendFactory: () => ISessionBackend = () => new MemorySessionBackend()) {
    this.defaultBackendFactory = defaultBackendFactory;
  }

  public createSession(sessionId: string, options: CreateSessionOptions = {}): ManagedSession {
    if (this.sessions.has(sessionId)) {
      throw new Error(`Session '${sessionId}' already exists.`);
    }

    const editor = new HeadlessEditorState(options.initialText || '');
    const ghost = new GhostTextManager(editor);
    const backend = options.backend || this.defaultBackendFactory();

    let modelCfg: ModelConfig | undefined;
    if (typeof options.model === 'string') {
      modelCfg = getModelPreset(options.model);
    } else if (options.model) {
      modelCfg = options.model;
    }

    const session: ManagedSession = {
      sessionId,
      editor,
      ghost,
      backend,
      messages: [],
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      modelConfig: modelCfg
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  public getSession(sessionId: string): ManagedSession | undefined {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.lastActiveAt = Date.now();
    }
    return s;
  }

  public getOrCreateSession(sessionId: string, options: CreateSessionOptions = {}): ManagedSession {
    const existing = this.getSession(sessionId);
    if (existing) return existing;
    return this.createSession(sessionId, options);
  }

  public closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.backend?.close().catch(() => {});
    this.sessions.delete(sessionId);
    return true;
  }

  public listSessions(): Array<{
    sessionId: string;
    createdAt: number;
    lastActiveAt: number;
    messageCount: number;
    docSize: number;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
      messageCount: s.messages.length,
      docSize: s.editor.getText().length
    }));
  }
}
