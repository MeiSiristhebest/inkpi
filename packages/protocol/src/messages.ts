export type MessageRole = 'user' | 'assistant' | 'toolResult' | 'system' | 'custom';

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ThinkingContent {
  type: 'thinking';
  thinking: string;
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
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  reasoningTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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

export interface AssistantMessage extends BaseMessage {
  role: 'assistant';
  content: ContentBlock[];
  stopReason?: 'stop' | 'tool_use' | 'length' | 'error' | 'aborted';
  errorMessage?: string;
  usage?: Usage;
}

export interface ToolResultMessage extends BaseMessage {
  role: 'toolResult';
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
}

export interface SystemMessage extends BaseMessage {
  role: 'system';
  content: string;
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
}

export interface BranchSummaryDetails {
  fromLeafId: string;
  toLeafId: string;
  commonAncestorId: string | null;
  divergedNodeCount: number;
  summary: string;
  discardedIdeas?: string[];
}

/** 通用技能模型 (1:1 对标 repos/pi Skills) */
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

/** 实时时延与缓存度量 (1:1 对标 repos/pi Timings & CacheStats) */
export interface TelemetryStats {
  ttftMs: number; // Time to first token
  totalDurationMs: number;
  tokensPerSecond: number;
  cacheHitRate: number; // 0.0 - 1.0
  estimatedCostUsd: number;
  thinkingTokens?: number;
  spans?: TelemetrySpan[];
}

/** 会话多格式导出选项 (1:1 对标 repos/pi SessionExport) */
export interface ExportOptions {
  format: 'html' | 'markdown' | 'json' | 'jsonl';
  title?: string;
  includeThinking?: boolean;
  includeToolCalls?: boolean;
  includeDiffs?: boolean;
}
