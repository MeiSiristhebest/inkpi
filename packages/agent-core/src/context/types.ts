import type { AiTask } from '@inkpi/protocol';

export interface ContextRequest {
  task: AiTask;
  signal?: AbortSignal;
  purpose?: string;
  projectRevision?: number;
  metadata?: Record<string, unknown>;
}

export interface ContextFragment {
  id: string;
  source: string;
  kind?: string;
  text?: string;
  data?: unknown;
  /** Neutral alias for data used by protocol-level providers. */
  content?: unknown;
  priority?: number;
  relevance?: number;
  recency?: number;
  dependency?: number;
  tokenEstimate?: number;
  estimatedTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface ContextPacket {
  fragments: ContextFragment[];
  text: string;
  tokenEstimate: number;
  fingerprint: string;
  truncated: boolean;
  projectRevision?: number;
  metadata?: Record<string, unknown>;
}

export interface ContextProvider {
  id: string;
  supports?(request: ContextRequest): boolean | Promise<boolean>;
  provide(request: ContextRequest, signal?: AbortSignal): ContextFragment[] | Promise<ContextFragment[]>;
}
