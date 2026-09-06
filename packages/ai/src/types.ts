import type { AgentMessage, AssistantMessage, AssistantMessageEvent, ProviderType, Usage } from '@inkpi/protocol';

export type { ProviderType };

/**
 * Anthropic 自适应思考的 effort 档位（对齐上游 pi AnthropicEffort）。
 * "xhigh" 仅部分原生模型支持；通用映射只产出 low/medium/high/max。
 */
export type AnthropicEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface CacheControl {
  type: 'ephemeral' | 'disabled';
  /**
   * 显式缓存生命周期选项（对齐上游 v0.85.1 GPT-6 Astra / Responses API）。
   * 例如针对长会话指定 ttl: '30m'，确保多轮推演高频问答下的热缓存保持。
   */
  ttl?: '30m' | '1h' | '24h';
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
  /**
   * 是否支持逐轮思考档位（Anthropic 自适应思考 / mid-conversation effort）。
   * 置为 true 时流式请求走 effort 路径，并把当轮档位记录在 assistant 消息上，
   * 回放历史时按轮次还原（对齐上游 pi v0.85.0 compat.supportsMidConvoEffort）。
   */
  supportsMidConvoEffort?: boolean;
  supportsThinking?: boolean;
  supportsPromptCache?: boolean;
  cacheControl?: { type: 'ephemeral' | 'disabled' };
  /** Explicit faux-provider fixture. Never inferred by production providers. */
  fauxScript?: FauxScriptedResponse;
  /**
   * 声明式方言兼容与运行时容错选项（面向小众/非标/自部署网关）。
   */
  compat?: ModelCompatConfig;
}

/**
 * 思考/推理参数的传输格式：
 * - 'openai': 标准 reasoning_effort
 * - 'deepseek': thinking: { type: 'enabled' }
 * - 'qwen-bool': 顶层 enable_thinking: true
 * - 'openrouter': reasoning: { effort: string }
 * - 'custom-field': 顶层自定义字段（配合 thinkingCustomField）
 * - 'disabled': 显式禁用思考参数发送
 */
export type ThinkingWireFormat = 'openai' | 'deepseek' | 'qwen-bool' | 'openrouter' | 'custom-field' | 'disabled';

export interface ModelCompatConfig {
  /**
   * 思考/推理字段的传输格式。未设置时根据 provider 推导或遵循标准。
   */
  thinkingFormat?: ThinkingWireFormat;
  /**
   * 当 thinkingFormat 为 'custom-field' 时使用的字段名，如 "thinking_budget"。
   */
  thinkingCustomField?: string;
  /**
   * 指定 max_tokens 的字段名（某些网关使用 max_completion_tokens 或仅接受 max_tokens）。
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /**
   * 是否发送 stream_options: { include_usage: true }。
   * 默认为 true；某些老旧 vLLM 或非标网关遇此字段会报 400，置为 false 则不发送。
   */
  supportsUsageInStreaming?: boolean;
  /**
   * 自定义透传到请求根 Body 的额外字段（任何私有定制字段均可直接在此配置）。
   */
  extraBody?: Record<string, unknown>;
  /**
   * 自定义额外 Header（如租户 ID、特定路由 Flag）。
   */
  extraHeaders?: Record<string, string>;
  /**
   * 是否开启报错自动自愈重试（默认 true）。
   * 遭遇 400 时自动剥离 stream_options / thinking / tools 畸形字段并重新发起单次请求。
   */
  enableSelfHealing?: boolean;
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
  /**
   * Anthropic 自适应思考 effort（仅 supportsMidConvoEffort 模型生效）。
   * 提供时优先于 thinkingBudget：thinking 走 adaptive + output_config.effort，
   * 并把当轮档位记入 assistant 消息（providerThinkingLevel）以便逐轮回放。
   */
  thinkingEffort?: AnthropicEffort;
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
