import type { AgentMessage, AssistantMessage, AssistantMessageEvent, Usage, ProviderType } from '@inkpi/protocol';

export type { ProviderType };

export interface CacheControl {
  type: 'ephemeral';
}

export interface PromptCacheStats {
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

export interface ModelConfig {
  id: string;
  name: string;
  provider: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
  thinkingBudget?: number;
  supportsThinking?: boolean;
  supportsPromptCache?: boolean;
  cacheControl?: { type: 'ephemeral' | 'disabled' };
  /** Explicit faux-provider fixture. Never inferred by production providers. */
  fauxScript?: FauxScriptedResponse;
}

export interface FauxScriptedResponse {
  thinking?: string;
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  usage?: Usage;
  /** @deprecated Use usage. */
  inputTokens?: number;
  /** @deprecated Use usage. */
  outputTokens?: number;
  /** @deprecated Use usage. */
  cacheReadTokens?: number;
  /** @deprecated Use usage. */
  cacheWriteTokens?: number;
  /** @deprecated Use usage. */
  reasoningTokens?: number;
}

export interface StreamOptions {
  signal?: AbortSignal;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  cacheControl?: boolean | CacheControl;
  tools?: Array<{
    name: string;
    description: string;
    parameters: unknown;
  }>;
}

export type StreamFn = (
  model: ModelConfig,
  messages: AgentMessage[],
  options?: StreamOptions
) => EventStream<AssistantMessageEvent>;

export interface EventStream<T> extends AsyncIterable<T> {
  on(listener: (event: T) => void | Promise<void>): () => void;
  waitForListeners?(): Promise<void>;
  collect(): Promise<AssistantMessage>;
  abort(): void;
}
