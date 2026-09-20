import type { ToolExecutionMode, ToolReplayPolicy } from './extensions.js';
import type { JsonObject, JsonValue } from './json.js';

/** JSON-safe, secret-free description of one executable model route. */
export interface ExecutionModelSnapshot {
  canonicalId?: string;
  provider: string;
  modelId: string;
  displayName?: string;
  baseUrl?: string;
  thinkingLevel?: string;
}

/** JSON-safe tool contract captured for reproducibility; execute functions are never serialized. */
export interface ExecutionToolSnapshot {
  name: string;
  label?: string;
  description: string;
  parameters?: JsonValue;
  executionMode?: ToolExecutionMode;
  replay?: ToolReplayPolicy;
}

export interface ExecutionInstructionsSnapshot {
  systemPrompt: string;
  thinkingLevel?: string;
}

export interface ExecutionContextSnapshot {
  messageCount: number;
  messageIds: string[];
  fingerprint: string;
  estimatedTokens?: number;
}

/**
 * Reproducibility manifest for one run. It intentionally contains no API keys,
 * tool functions, arbitrary message payloads, or provider response bodies.
 */
export interface ExecutionSnapshot {
  version: 1;
  id: string;
  taskId?: string;
  createdAt: number;
  model: ExecutionModelSnapshot;
  instructions: ExecutionInstructionsSnapshot;
  tools: ExecutionToolSnapshot[];
  context: ExecutionContextSnapshot;
  policy?: JsonObject;
  metadata?: JsonObject;
}
