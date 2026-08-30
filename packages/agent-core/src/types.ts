import type {
  AgentMessage,
  AssistantMessage,
  ToolResultMessage,
  AgentTool,
  ToolExecutionMode,
  ToolCallContent,
  Usage,
  TextContent,
  ImageContent
} from '@inkpi/protocol';
import type { ModelConfig, StreamFn } from '@inkpi/ai';

export type { ToolExecutionMode };
export type QueueMode = 'all' | 'one-at-a-time';
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'none';


export interface AgentState {
  systemPrompt: string;
  model: ModelConfig;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool[];
  messages: AgentMessage[];
  isStreaming: boolean;
  streamingMessage?: AssistantMessage;
  pendingToolCalls: Set<string>;
  errorMessage?: string;
}

export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCallContent;
  args: unknown;
  context?: unknown;
}

export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

export interface AfterToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCallContent;
  args: unknown;
  result: {
    content: (TextContent | ImageContent)[];
    details?: unknown;
  };
  isError: boolean;
}

export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
  usage?: Usage;
  terminate?: boolean;
}

export interface ShouldStopAfterTurnContext {
  assistantMessage: AssistantMessage;
  toolResults: ToolResultMessage[];
}

export interface AgentOptions {
  initialState?: Partial<Omit<AgentState, 'pendingToolCalls' | 'isStreaming' | 'streamingMessage' | 'errorMessage'>>;
  convertToLlm?: (messages: AgentMessage[]) => AgentMessage[] | Promise<AgentMessage[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: ToolExecutionMode;
  streamFn?: StreamFn;
  sessionId?: string;
  beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | void>;
  afterToolCall?: (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | void>;
  shouldStopAfterTurn?: (ctx: ShouldStopAfterTurnContext, signal?: AbortSignal) => Promise<boolean>;
}
