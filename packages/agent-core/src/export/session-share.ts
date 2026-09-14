import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentMessage, RuntimeState, StateLedger } from '@inkpi/protocol';
import type { SessionTree } from '../tree.js';
import { escapeHtml } from './html.js';
import { SESSION_SHARE_STYLE } from './report-assets.js';

export interface SessionShareOptions {
  title?: string;
  author?: string;
  category?: string;
  tags?: string[];
  sanitizeApiKeys?: boolean;
  sanitizeLocalPaths?: boolean;
  includeThinking?: boolean;
  includeToolCalls?: boolean;
  includeState?: boolean;
  includeSessionTree?: boolean;
  customRedactPatterns?: RegExp[];
  clock?: () => number;
}

/** Adapter for preparing opaque state for an export without Runtime inspection. */
export interface RuntimeStateShareAdapter<TState extends RuntimeState = RuntimeState> {
  clone(state: TState): TState;
  stats?(state: TState): Record<string, number>;
}

export interface RuntimeSessionShareOptions<TState extends RuntimeState = RuntimeState> extends SessionShareOptions {
  stateAdapter?: RuntimeStateShareAdapter<TState>;
}

export interface RuntimeSessionShareSource<TState extends RuntimeState = RuntimeState> {
  messages: AgentMessage[];
  tree?: SessionTree;
  state?: TState;
  /** @deprecated Use state. Kept as a domain-neutral compatibility alias. */
  runtimeState?: TState;
  systemPrompt?: string;
}

export interface SessionDatasetPayload<TState extends RuntimeState = RuntimeState> {
  version: '1.0';
  id: string;
  title: string;
  author: string;
  category: string;
  tags: string[];
  createdAt: number;
  exportedAt: number;
  stats: {
    turnsCount: number;
    totalMessages: number;
    branchesCount: number;
  };
  systemPrompt: string;
  state?: TState;
  stateStats?: Record<string, number>;
  branches?: Array<{ leafId: string; length: number; lastMessage: AgentMessage }>;
  messages: AgentMessage[];
}

const DEFAULT_API_KEY_REGEX = /\b(sk-[a-zA-Z0-9_-]{20,}|Bearer\s+[a-zA-Z0-9_\-\.]{20,}|key-[a-zA-Z0-9]{16,})\b/gi;
const DEFAULT_PATH_REGEX = /([A-Za-z]:\\[\w\s\.\-\\]+|\/(?:home|Users|var|tmp|etc)\/[\w\s\.\-\/]+)/g;

function sanitizeText(text: string, options: SessionShareOptions): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let sanitized = text;

  if (options.sanitizeApiKeys !== false) {
    sanitized = sanitized.replace(DEFAULT_API_KEY_REGEX, '[REDACTED_API_KEY]');
  }
  if (options.sanitizeLocalPaths !== false) {
    sanitized = sanitized.replace(DEFAULT_PATH_REGEX, '[REDACTED_LOCAL_PATH]');
  }
  if (options.customRedactPatterns) {
    for (const pattern of options.customRedactPatterns) {
      sanitized = sanitized.replace(pattern, '[REDACTED]');
    }
  }
  return sanitized;
}

function sanitizeMessage(message: AgentMessage, options: SessionShareOptions): AgentMessage {
  let cloned: AgentMessage;
  try {
    cloned = JSON.parse(JSON.stringify(message)) as AgentMessage;
  } catch {
    return { ...message };
  }

  if (typeof cloned.content === 'string') {
    cloned.content = sanitizeText(cloned.content, options);
  } else if (Array.isArray(cloned.content)) {
    cloned.content = cloned.content.map((block) => {
      if (block.type === 'text') return { ...block, text: sanitizeText(block.text, options) };
      if (block.type === 'thinking') return { ...block, thinking: sanitizeText(block.thinking, options) };
      if (block.type === 'toolCall') {
        let sanitizedArgs = block.arguments;
        try {
          sanitizedArgs = JSON.parse(sanitizeText(JSON.stringify(block.arguments), options));
        } catch {
          // Retain original arguments when they cannot be serialized safely.
        }
        return { ...block, arguments: sanitizedArgs };
      }
      return block;
    });
  }
  return cloned;
}

function cloneOpaqueState<TState extends RuntimeState>(
  state: TState,
  adapter?: RuntimeStateShareAdapter<TState>
): TState {
  return adapter ? adapter.clone(state) : structuredClone(state);
}

/**
 * Generic Runtime session exporter. State is transported opaquely and can be
 * prepared only by a caller-supplied adapter.
 */
export const RuntimeSessionShareExporter = {
  sanitize(text: string, options: SessionShareOptions = {}): string {
    return sanitizeText(text, options);
  },

  sanitizeMessage(message: AgentMessage, options: SessionShareOptions = {}): AgentMessage {
    return sanitizeMessage(message, options);
  },

  exportDataset<TState extends RuntimeState = RuntimeState>(
    source: RuntimeSessionShareSource<TState>,
    options: RuntimeSessionShareOptions<TState> = {}
  ): SessionDatasetPayload<TState> {
    const rawMessages = source.messages || [];
    const sanitizedMessages = rawMessages.map((message) => {
      const sanitized = sanitizeMessage(message, options);
      if (sanitized.role !== 'assistant' || !Array.isArray(sanitized.content)) return sanitized;

      let content = sanitized.content;
      if (options.includeThinking === false) content = content.filter((block) => block.type !== 'thinking');
      if (options.includeToolCalls === false) content = content.filter((block) => block.type !== 'toolCall');
      return { ...sanitized, content };
    });

    const rawState = source.state ?? source.runtimeState;
    const exportedState =
      options.includeState !== false && rawState !== undefined
        ? cloneOpaqueState(rawState, options.stateAdapter)
        : undefined;
    const stateStats = exportedState === undefined ? undefined : options.stateAdapter?.stats?.(exportedState);
    const branches = source.tree ? source.tree.getBranches() : [];
    const now = options.clock ? options.clock() : Date.now();

    return {
      version: '1.0',
      id: `share_${crypto.randomUUID().slice(0, 10)}`,
      title: options.title || 'Session Share',
      author: options.author || 'Anonymous',
      category: options.category || 'agent-session',
      tags: options.tags || ['agent-session', 'inkpi'],
      createdAt: now,
      exportedAt: now,
      stats: {
        turnsCount: sanitizedMessages.filter((message) => message.role === 'user').length,
        totalMessages: sanitizedMessages.length,
        branchesCount: branches.length
      },
      systemPrompt: sanitizeText(source.systemPrompt || '', options),
      ...(exportedState === undefined ? {} : { state: exportedState }),
      ...(stateStats === undefined ? {} : { stateStats }),
      ...(options.includeSessionTree === false ? {} : { branches }),
      messages: sanitizedMessages
    };
  },

  exportShareHtml<TState extends RuntimeState>(dataset: SessionDatasetPayload<TState>): string {
    const messagesHtml = dataset.messages
      .map((message) => {
        const isUser = message.role === 'user';
        const roleLabel = isUser ? 'User' : message.role === 'assistant' ? 'Assistant' : message.role;
        let body = '';
        if (typeof message.content === 'string') {
          body = `<div class="msg-text">${escapeHtml(message.content)}</div>`;
        } else if (Array.isArray(message.content)) {
          body = message.content
            .map((block) => {
              if (block.type === 'thinking') {
                return `<div class="msg-thinking"><span class="badge">Thinking</span><pre>${escapeHtml(block.thinking)}</pre></div>`;
              }
              if (block.type === 'text') return `<div class="msg-text">${escapeHtml(block.text)}</div>`;
              if (block.type === 'toolCall') {
                return `<div class="msg-tool"><span class="badge">Tool</span> <code>${escapeHtml(block.name)}</code></div>`;
              }
              return '';
            })
            .join('');
        } else {
          body = `<pre class="msg-text">${escapeHtml(JSON.stringify(message.content))}</pre>`;
        }
        return `
        <div class="message-card ${isUser ? 'user' : 'assistant'}">
          <div class="message-header"><span class="role-badge">${roleLabel}</span></div>
          <div class="message-body">${body}</div>
        </div>`;
      })
      .join('\n');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(dataset.title)}</title>
  <style>
${SESSION_SHARE_STYLE}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${escapeHtml(dataset.title)}</h1>
      <div class="meta-bar">
        <span>Author: ${escapeHtml(dataset.author)}</span>
        <span>${dataset.tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join(' ')}</span>
        <span>${dataset.stats.turnsCount} Turns | ${dataset.stats.totalMessages} Messages</span>
      </div>
    </header>
    <main>${messagesHtml}</main>
  </div>
</body>
</html>`;
  },

  /** Run concurrent exports in an isolated temporary directory. */
  async withIsolatedExportSandbox<T>(action: (tempDir: string) => Promise<T>): Promise<T> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkpi-share-'));
    try {
      return await action(tempDir);
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup failure; the caller's export result is already known.
      }
    }
  }
};

// ---------------------------------------------------------------------------
// Explicit creative compatibility adapter.
// ---------------------------------------------------------------------------

export interface CreativeSessionShareOptions extends SessionShareOptions {
  /** @deprecated Use includeState. */
  includeStateLedger?: boolean;
}

export interface CreativeDatasetPayload {
  version: '1.0';
  id: string;
  title: string;
  author: string;
  category: string;
  tags: string[];
  createdAt: number;
  exportedAt: number;
  stats: {
    turnsCount: number;
    totalMessages: number;
    branchesCount: number;
    entitiesCount: number;
  };
  systemPrompt: string;
  stateLedger?: StateLedger;
  branches?: Array<{ leafId: string; length: number; lastMessage: AgentMessage }>;
  messages: AgentMessage[];
}

const creativeStateShareAdapter: RuntimeStateShareAdapter<StateLedger> = {
  clone: (state) => structuredClone(state),
  stats: (state) => ({ entitiesCount: state.entities?.length ?? state.characters?.length ?? 0 })
};

/**
 * Creative-domain compatibility facade. It translates the old StateLedger
 * payload to the generic `state` slot and is the only place that interprets
 * entity counts or creative export defaults.
 */
export const CreativeSessionShareExporter = {
  sanitize(text: string, options: CreativeSessionShareOptions = {}): string {
    return RuntimeSessionShareExporter.sanitize(text, options);
  },

  sanitizeMessage(message: AgentMessage, options: CreativeSessionShareOptions = {}): AgentMessage {
    return RuntimeSessionShareExporter.sanitizeMessage(message, options);
  },

  exportDataset(
    source: {
      messages: AgentMessage[];
      tree?: SessionTree;
      stateLedger?: StateLedger;
      systemPrompt?: string;
    },
    options: CreativeSessionShareOptions = {}
  ): CreativeDatasetPayload {
    const includeState = options.includeState !== false && options.includeStateLedger !== false;
    const dataset = RuntimeSessionShareExporter.exportDataset(
      {
        messages: source.messages,
        tree: source.tree,
        state: source.stateLedger,
        systemPrompt: source.systemPrompt
      },
      {
        ...options,
        title: options.title || 'Creative Session Share',
        author: options.author || 'Anonymous Creator',
        category: options.category || 'creative-writing',
        tags: options.tags || ['agentic-writing', 'inkpi'],
        includeState,
        stateAdapter: creativeStateShareAdapter
      }
    );
    const { state, stateStats, ...genericDataset } = dataset;
    return {
      ...genericDataset,
      stats: {
        ...genericDataset.stats,
        entitiesCount: stateStats?.entitiesCount || 0
      },
      ...(state === undefined ? {} : { stateLedger: state })
    };
  },

  exportShareHtml(dataset: CreativeDatasetPayload): string {
    return RuntimeSessionShareExporter.exportShareHtml(dataset as unknown as SessionDatasetPayload<RuntimeState>);
  },

  withIsolatedExportSandbox<T>(action: (tempDir: string) => Promise<T>): Promise<T> {
    return RuntimeSessionShareExporter.withIsolatedExportSandbox(action);
  }
};

/** @deprecated Use RuntimeSessionShareExporter or CreativeSessionShareExporter. */
export const SessionShareExporter = CreativeSessionShareExporter;
