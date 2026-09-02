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
import type { ModelConfig } from '@inkpi/ai';
import type { ModelStreamer } from './ports/index.js';

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
  sessionId?: string;
  operations?: Map<string, any>;
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
  streamFn?: ModelStreamer;
  sessionId?: string;
  journal?: any;
  beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | void>;
  afterToolCall?: (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | void>;
  shouldStopAfterTurn?: (ctx: ShouldStopAfterTurnContext, signal?: AbortSignal) => Promise<boolean>;
}
