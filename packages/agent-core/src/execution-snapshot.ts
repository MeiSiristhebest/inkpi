import type { ModelConfig } from '@inkpi/ai';
import {
  type AgentMessage,
  type AgentTool,
  type ExecutionSnapshot,
  type JsonObject,
  type JsonValue,
  assertJsonValue
} from '@inkpi/protocol';

export interface ExecutionSnapshotInput {
  id: string;
  taskId?: string;
  createdAt: number;
  model: ModelConfig;
  canonicalModelId?: string;
  systemPrompt: string;
  thinkingLevel?: string;
  tools: readonly AgentTool[];
  messages: readonly AgentMessage[];
  estimatedTokens?: number;
  policy?: JsonObject;
  metadata?: JsonObject;
}

/**
 * Build a secret-free, JSON-safe execution manifest. Runtime functions and
 * credentials remain in the process-local execution environment.
 */
export function createExecutionSnapshot(input: ExecutionSnapshotInput): ExecutionSnapshot {
  assertNonEmptyString(input.id, 'Execution snapshot id');
  assertFiniteNonNegative(input.createdAt, 'Execution snapshot createdAt');
  assertNonEmptyString(input.model.id, 'Execution snapshot model id');
  assertNonEmptyString(input.model.provider, 'Execution snapshot provider');
  assertNonEmptyString(input.systemPrompt, 'Execution snapshot system prompt', true);

  if (input.estimatedTokens !== undefined) {
    assertFiniteNonNegative(input.estimatedTokens, 'Execution snapshot estimatedTokens');
  }
  if (input.policy !== undefined) assertJsonObject(input.policy, 'Execution snapshot policy');
  if (input.metadata !== undefined) assertJsonObject(input.metadata, 'Execution snapshot metadata');

  const tools = input.tools.map((tool) => createToolSnapshot(tool));
  const messageIds = input.messages.map((message, index) => message.id ?? `${index}:${message.role}`);

  return {
    version: 1,
    id: input.id,
    ...(input.taskId ? { taskId: input.taskId } : {}),
    createdAt: input.createdAt,
    model: {
      ...(input.canonicalModelId ? { canonicalId: input.canonicalModelId } : {}),
      provider: input.model.provider,
      modelId: input.model.id,
      ...(input.model.name ? { displayName: input.model.name } : {}),
      ...(sanitizeEndpoint(input.model.baseUrl) ? { baseUrl: sanitizeEndpoint(input.model.baseUrl) } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {})
    },
    instructions: {
      systemPrompt: input.systemPrompt,
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {})
    },
    tools,
    context: {
      messageCount: input.messages.length,
      messageIds,
      fingerprint: fingerprint(messageIds),
      ...(input.estimatedTokens !== undefined ? { estimatedTokens: input.estimatedTokens } : {})
    },
    ...(input.policy ? { policy: input.policy } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {})
  };
}

function createToolSnapshot(tool: AgentTool): ExecutionSnapshot['tools'][number] {
  assertNonEmptyString(tool.name, 'Execution snapshot tool name');
  assertNonEmptyString(tool.description, `Execution snapshot tool '${tool.name}' description`, true);
  let parameters: JsonValue | undefined;
  if (tool.parameters !== undefined) {
    assertJsonValue(tool.parameters, `Execution snapshot tool '${tool.name}' parameters`);
    parameters = tool.parameters;
  }

  return {
    name: tool.name,
    ...(tool.label ? { label: tool.label } : {}),
    description: tool.description,
    ...(parameters !== undefined ? { parameters } : {}),
    ...(tool.executionMode ? { executionMode: tool.executionMode } : {}),
    ...(tool.replay ? { replay: tool.replay } : {})
  };
}

function assertJsonObject(value: unknown, context: string): asserts value is JsonObject {
  assertJsonValue(value, context);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be a JSON object`);
  }
}

function assertNonEmptyString(value: unknown, context: string, allowEmpty = false): asserts value is string {
  if (typeof value !== 'string' || (!allowEmpty && value.trim().length === 0)) {
    throw new Error(`${context} must be a ${allowEmpty ? '' : 'non-empty '}string`);
  }
}

function assertFiniteNonNegative(value: unknown, context: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${context} must be a finite non-negative number`);
  }
}

function sanitizeEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    // Preserve opaque local endpoints only when they cannot contain obvious
    // userinfo/query secrets. Invalid/unsafe endpoints are omitted.
    return /[?#]|\/\/[^/]*@/.test(value) ? undefined : value;
  }
}

/** Fingerprint IDs only to avoid creating guessable hashes of private message content. */
function fingerprint(values: readonly string[]): string {
  const serialized = JSON.stringify(values);
  let hash = 0x811c9dc5;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
