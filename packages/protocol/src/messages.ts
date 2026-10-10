export type MessageRole = 'user' | 'assistant' | 'toolResult' | 'system' | 'custom';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
  /** Opaque provider data required to replay this block with tool-use history. */
  providerSignature?: string;
  /** Original provider content-block index, used to preserve interleaved output order. */
  providerBlockIndex?: number;
}

export interface ImageContent {
  type: 'image';
  image: string; // Base64 or URL
  mimeType?: string;
}

export interface ToolCallContent {
  type: 'toolCall';
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContentBlock = TextContent | ThinkingContent | ImageContent | ToolCallContent;

export interface Usage {
  /** Input tokens outside the separately reported prompt cache read/write counts. */
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Provider-reported full prompt length, including cached input, for tiered pricing. */
  promptTokens?: number;
  /** Provider-reported execution tier used for service-tier pricing. */
  serviceTier?: string;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite5mTokens?: number;
  cacheWrite1hTokens?: number;
}

export interface BaseMessage {
  id?: string;
  role: MessageRole;
  timestamp?: number;
}

export interface UserMessage extends BaseMessage {
  role: 'user';
  content: string | (TextContent | ImageContent)[];
}

export interface ProviderErrorMetadata {
  code?: string;
  message?: string;
  retryable?: boolean;
  provider?: string;
  status?: number;
  retryAfterMs?: number;
  maxDelayMs?: number;
  details?: unknown;
}

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  content: ContentBlock[];
  stopReason?: 'stop' | 'tool_use' | 'length' | 'error' | 'aborted';
  errorMessage?: string;
  /** Structured provider failure metadata preserved across the stream boundary. */
  providerError?: ProviderErrorMetadata;
  usage?: Usage;
  /** Provider request duration measured with a monotonic clock. */
  durationMs?: number;
  /**
   * 本条消息生成时使用的 provider 思考档位（如 Anthropic 自适应思考 effort）。
   * 回放历史时按轮次还原逐轮 effort，避免中途调档后串档（对齐上游 pi v0.85.0）。
   */
  providerThinkingLevel?: string;
}

export interface ToolResultMessage extends BaseMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  /** execute() duration, excluding gates and hooks; absent when the tool did not run. */
  durationMs?: number;
}

export interface SystemMessage extends BaseMessage {
  role: 'system';
  content: string;
  sections?: Record<string, string | null>;
  toolsAdded?: ModelToolDefinition[];
  toolsRemoved?: Array<{ name: string }>;
}

/** Persistable tool declaration; executable functions remain in the host. */
export interface ModelToolDefinition {
  name: string;
  description: string;
  parameters: unknown;
}

export interface CustomMessage extends BaseMessage {
  role: 'custom';
  customType: string;
  content: unknown;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | SystemMessage | CustomMessage;

export type StandardLlmRole = 'system' | 'user' | 'assistant' | 'tool';

export interface StandardLlmMessage {
  role: StandardLlmRole;
  content: string;
  toolCallId?: string;
  toolCalls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export type ProviderType =
  | 'deepseek'
  | 'openai'
  | 'claude'
  | 'gemini'
  | 'ollama'
  | 'bedrock'
  | 'groq'
  | 'mistral'
  | 'xai'
  | 'openrouter'
  | 'azure'
  | 'siliconflow'
  | 'qwen'
  | 'z-ai'
  | 'faux'
  | 'custom';

export interface ModelConfig {
  id: string;
  name: string;
  provider: ProviderType;
  baseUrl?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  contextWindow?: number;
  supportsThinking?: boolean;
  supportsTools?: boolean;
  presencePenalty?: number;
  frequencyPenalty?: number;
  cacheControl?: { type: 'ephemeral' | 'disabled' };
}

export type ThinkingLevel = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens?: number;
  totalTokens: number;
  costUsd: number;
  /** Missing or incomplete pricing is not equivalent to a free request. */
  costStatus?: 'known' | 'partial' | 'unknown';
}

export interface BranchSummaryDetails {
  fromLeafId: string;
  toLeafId: string;
  commonAncestorId: string | null;
  divergedNodeCount: number;
  summary: string;
  discardedIdeas?: string[];
}

/** 通用技能模型 */
export interface SkillInfo {
  name: string;
  description: string;
  filePath: string;
  frontmatter: Record<string, unknown>;
  promptBody: string;
}

export interface TelemetrySpan {
  id: string;
  name: string;
  stage?: string;
  role?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  thinkingTokens?: number;
  costUsd?: number;
  attributes?: Record<string, unknown>;
}

export interface CreativeInteractionMetrics {
  ghostText: {
    totalSuggestions: number;
    acceptedFull: number;
    acceptedWord: number;
    acceptedLine: number;
    dismissed: number;
    acceptedChars: number;
    dismissedChars: number;
    acceptanceRate: number;
  };
  branching: {
    branchCount: number;
    rollbackCount: number;
    rollbackRate: number;
  };
  invariants: {
    conflictsBlockedCount: number;
    conflictRules: string[];
  };
}

export type TelemetryEvent =
  | {
      type: 'ghost_text_interaction';
      action: 'accept_full' | 'accept_word' | 'accept_line' | 'dismiss';
      charCount: number;
      timestamp: number;
    }
  | {
      type: 'branch_rollback';
      branchId: string;
      depth: number;
      timestamp: number;
    }
  | {
      type: 'invariant_conflict';
      rule: string;
      details?: string;
      timestamp: number;
    }
  | { type: 'turn_telemetry'; stats: TelemetryStats; timestamp: number };

/** 实时时延与缓存度量 */
export interface TelemetryStats {
  ttftMs: number; // Time to first token
  totalDurationMs: number;
  tokensPerSecond: number;
  cacheHitRate: number; // 0.0 - 1.0
  estimatedCostUsd: number;
  thinkingTokens?: number;
  spans?: TelemetrySpan[];
  creativeMetrics?: CreativeInteractionMetrics;
}

/** 会话多格式导出选项 */
export interface ExportOptions {
  format: 'html' | 'markdown' | 'json' | 'jsonl';
  title?: string;
  includeThinking?: boolean;
  includeToolCalls?: boolean;
  includeDiffs?: boolean;
  labels?: {
    user?: string;
    assistant?: string;
    thinking?: string;
    toolCall?: string;
    toolResult?: string;
    system?: string;
    custom?: string;
    branches?: string;
    messages?: string;
  };
}
