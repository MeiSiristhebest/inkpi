import type { ModelConfig } from '@inkpi/ai';
import type {
  AgentMessage,
  AgentTool,
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolCallContent,
  ToolExecutionMode,
  ToolResultMessage,
  Usage
} from '@inkpi/protocol';
import type { ContextBudgetPlanner, SessionCompactor } from './compaction/index.js';
import type { Clock, IdGenerator, ModelStreamer, ThinkingMapper } from './ports/index.js';

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

/** Input to an opt-in incremental context transform. */
export interface IncrementalContextUpdate {
  /** The current transcript head. Falls back to a per-state cursor when a message has no id. */
  headId: string | null;
  /** New messages since the previous update, or the full transcript when reset is true. */
  messages: readonly AgentMessage[];
  /** The transform's previous complete view. Empty when reset is true. */
  previousView: readonly AgentMessage[];
  /** True for first use, history replacement, compaction, truncation, or an in-place array edit. */
  reset: boolean;
  /** Monotonic mutation revision for this in-memory AgentState. */
  revision: number;
  totalMessageCount: number;
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
  /**
   * Incrementally builds a complete model-context view from append-only history deltas.
   * On reset, messages contains the current full transcript and previousView is empty.
   * The returned array becomes the previousView for the next update. Do not mutate
   * previousView or message objects already in history. Replace an entry or assign
   * a new messages array to rebuild the view after an edit. Existing transformContext
   * and convertToLlm callbacks keep their full-history semantics.
   */
  incrementalTransformContext?: (
    update: IncrementalContextUpdate,
    signal?: AbortSignal
  ) => AgentMessage[] | Promise<AgentMessage[]>;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  toolExecution?: ToolExecutionMode;
  streamFn?: ModelStreamer;
  thinkingMapper?: ThinkingMapper;
  idGenerator?: IdGenerator;
  clock?: Clock;
  sessionId?: string;
  journal?: any;
  beforeToolCall?: (ctx: BeforeToolCallContext) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (ctx: AfterToolCallContext) => Promise<AfterToolCallResult | undefined>;
  shouldStopAfterTurn?: (ctx: ShouldStopAfterTurnContext, signal?: AbortSignal) => Promise<boolean>;
  /** Runtime compactor used before first call and during rolling tool history. */
  sessionCompactor?: SessionCompactor;
  contextBudgetPlanner?: ContextBudgetPlanner;
}
