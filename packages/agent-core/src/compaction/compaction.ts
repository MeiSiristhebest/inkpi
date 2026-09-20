import { CHARS_PER_TOKEN_HEURISTIC } from '@inkpi/ai';
import type { AgentMessage, AiTask, AssistantMessage, CompactionEntry } from '@inkpi/protocol';
import type { Clock } from '../ports/index.js';
import { type RuntimeState, type RuntimeStateExtractor, extractRuntimeState } from './runtime-state.js';
import { GENERIC_SUMMARIZATION_SYSTEM_PROMPT, serializeConversationForSummary } from './summarize.js';

export interface CompactionTaskBudget {
  /** Override the normal token trigger for one task kind. */
  triggerTokensThreshold?: number;
  /** Maximum input/context window available to this task. */
  contextWindowTokens?: number;
  /** Tokens reserved for the task's response. */
  outputReserveTokens?: number;
  /** Minimum number of recent messages to retain. */
  preserveRecentCount?: number;
  /** Minimum estimated tokens to retain from the recent tail. */
  preserveRecentTokens?: number;
  /** Maximum generated summary size, when the provider supports bounded output. */
  summaryTokens?: number;
}

/** The task fields used to select a task-aware compaction budget. */
export type CompactionTask = Pick<AiTask, 'kind' | 'contextPolicy'>;

export interface CompactionBudget {
  triggerTokensThreshold: number;
  contextWindowTokens?: number;
  outputReserveTokens: number;
  preserveRecentCount: number;
  preserveRecentTokens?: number;
  summaryTokens?: number;
}

export interface CompactionConfig {
  /** Trigger threshold in tokens (e.g. 100,000) */
  triggerTokensThreshold?: number;
  /** Maximum input/context window. If set, outputReserveTokens is subtracted before triggering. */
  contextWindowTokens?: number;
  /** Tokens reserved for the next model response. */
  outputReserveTokens?: number;
  /** Number of recent messages to preserve after compaction (e.g. 4) */
  preserveRecentCount?: number;
  /** Minimum estimated token count to preserve from the recent message tail. */
  preserveRecentTokens?: number;
  /** Maximum generated summary size in estimated tokens. */
  summaryTokens?: number;
  /** Optional overrides selected by the task's stable kind. */
  taskBudgets?: Record<string, CompactionTaskBudget>;
  /** Custom summarizer function */
  summarizer?: (serializedConversation: string, systemPrompt: string) => Promise<string>;
  /** Optional caller-owned adapter for extracting opaque state from compacted messages. */
  stateExtractors?: RuntimeStateExtractor[];
  /** Optional caller-owned formatter for the extracted opaque state. */
  stateFormatter?: (state: RuntimeState) => string;
  /** Injectable clock for timestamps / ids. Required — no `Date.now` fallback. */
  clock: Clock;
  /**
   * 字符→Token 估算系数（与 `@inkpi/ai` 的 `CHARS_PER_TOKEN_HEURISTIC` 同源，默认取其值）。
   * 触发判断与压缩后结算共用本系数；注入与线上 tokenizer 一致的值可获得真实计量。
   */
  charsPerToken?: number;
}

interface ResolvedCompactionConfig {
  charsPerToken: number;
  triggerTokensThreshold: number;
  contextWindowTokens?: number;
  outputReserveTokens: number;
  preserveRecentCount: number;
  preserveRecentTokens?: number;
  summaryTokens?: number;
  taskBudgets: Record<string, CompactionTaskBudget>;
  summarizer?: CompactionConfig['summarizer'];
  stateExtractors?: RuntimeStateExtractor[];
  stateFormatter?: CompactionConfig['stateFormatter'];
}

export interface CompactionResult {
  compactedMessages: AgentMessage[];
  entry: CompactionEntry;
  budget: CompactionBudget;
}

export class SessionCompactor {
  private config: ResolvedCompactionConfig;
  private clock: Clock;

  constructor(config: CompactionConfig) {
    this.clock = config.clock;
    this.config = {
      triggerTokensThreshold: positiveIntegerOr(config.triggerTokensThreshold, 50000),
      contextWindowTokens: positiveIntegerOrUndefined(config.contextWindowTokens),
      outputReserveTokens: nonNegativeIntegerOr(config.outputReserveTokens, 0),
      preserveRecentCount: positiveIntegerOr(config.preserveRecentCount, 4),
      preserveRecentTokens: positiveIntegerOrUndefined(config.preserveRecentTokens),
      summaryTokens: positiveIntegerOrUndefined(config.summaryTokens),
      taskBudgets: config.taskBudgets ?? {},
      summarizer: config.summarizer,
      stateExtractors: config.stateExtractors,
      stateFormatter: config.stateFormatter,
      charsPerToken: positiveNumberOr(config.charsPerToken, CHARS_PER_TOKEN_HEURISTIC)
    };
  }

  /** Resolve the effective budget without requiring callers to duplicate task policy. */
  public resolveBudget(task?: CompactionTask): CompactionBudget {
    const taskBudget = task?.kind ? this.config.taskBudgets[task.kind] : undefined;
    const contextWindowTokens =
      positiveIntegerOrUndefined(taskBudget?.contextWindowTokens) ??
      positiveIntegerOrUndefined(task?.contextPolicy?.maxTokens) ??
      this.config.contextWindowTokens;
    const outputReserveTokens =
      nonNegativeIntegerOrUndefined(taskBudget?.outputReserveTokens) ?? this.config.outputReserveTokens;
    const triggerTokensThreshold =
      positiveIntegerOrUndefined(taskBudget?.triggerTokensThreshold) ??
      (contextWindowTokens === undefined
        ? this.config.triggerTokensThreshold
        : Math.max(1, contextWindowTokens - outputReserveTokens));

    return {
      triggerTokensThreshold,
      contextWindowTokens,
      outputReserveTokens,
      preserveRecentCount:
        positiveIntegerOrUndefined(taskBudget?.preserveRecentCount) ?? this.config.preserveRecentCount,
      preserveRecentTokens:
        positiveIntegerOrUndefined(taskBudget?.preserveRecentTokens) ?? this.config.preserveRecentTokens,
      summaryTokens: positiveIntegerOrUndefined(taskBudget?.summaryTokens) ?? this.config.summaryTokens
    };
  }

  /** Estimate one message, including tool calls/results and custom JSON payloads. */
  public estimateMessageTokens(message: AgentMessage): number {
    let characterCount = message.role.length + 4;

    switch (message.role) {
      case 'user':
        characterCount += estimateContentValue(message.content);
        break;
      case 'assistant':
        characterCount += estimateContentValue(message.content);
        characterCount += estimateTextValue(message.errorMessage);
        characterCount += estimateTextValue(message.providerThinkingLevel);
        characterCount += estimateJsonValue(message.usage);
        break;
      case 'toolResult':
        characterCount += message.toolCallId.length + message.toolName.length;
        characterCount += estimateContentValue(message.content);
        characterCount += estimateJsonValue(message.details);
        characterCount += message.isError ? 4 : 0;
        break;
      case 'system':
        characterCount += message.content.length;
        break;
      case 'custom':
        characterCount += message.customType.length;
        characterCount += estimateJsonValue(message.content);
        break;
    }

    return Math.max(1, Math.ceil(characterCount * this.config.charsPerToken));
  }

  /**
   * Estimate all message tokens, including system/custom/tool content instead
   * of silently ignoring execution context that can dominate a task budget.
   */
  public estimateTokens(messages: AgentMessage[]): number {
    return messages.reduce((total, message) => total + this.estimateMessageTokens(message), 0);
  }

  /** Check if compaction should be triggered for the supplied task policy. */
  public shouldCompact(messages: AgentMessage[], task?: CompactionTask): boolean {
    const budget = this.resolveBudget(task);
    const tokens = this.estimateTokens(messages);
    const exceedsContextWindow =
      budget.contextWindowTokens !== undefined && tokens + budget.outputReserveTokens > budget.contextWindowTokens;

    // A hard task window takes precedence over the historical message-count
    // guard, but a single message has no safe earlier segment to summarize.
    if (exceedsContextWindow) return messages.length > 1;
    if (messages.length <= budget.preserveRecentCount + 2) return false;
    return tokens >= budget.triggerTokensThreshold;
  }

  /**
   * Execute atomic context compaction (1:1 aligned with repos/pi), using the
   * task budget to decide both the trigger accounting and recent-tail floor.
   */
  public async compact(
    messages: AgentMessage[],
    signal?: AbortSignal,
    task?: CompactionTask
  ): Promise<CompactionResult> {
    if (signal?.aborted) {
      throw new Error('Session compaction aborted by signal');
    }
    if (!this.config.summarizer) {
      throw new Error('Session compaction requires an explicit summarizer capability.');
    }

    const budget = this.resolveBudget(task);
    const tokensBefore = this.estimateTokens(messages);
    const splitIndex = this.findSplitIndex(messages, budget);

    const oldMessages = messages.slice(0, splitIndex);
    const keptMessages = messages.slice(splitIndex);

    const runtimeState = this.config.stateExtractors
      ? extractRuntimeState(oldMessages, this.config.stateExtractors)
      : undefined;
    const formattedState = runtimeState && this.config.stateFormatter ? this.config.stateFormatter(runtimeState) : '';

    // Generate conversation summary
    const serialized = serializeConversationForSummary(oldMessages);
    if (signal?.aborted) {
      throw new Error('Session compaction aborted by signal');
    }
    const generatedSummary = await this.config.summarizer(serialized, GENERIC_SUMMARIZATION_SYSTEM_PROMPT);
    if (signal?.aborted) {
      throw new Error('Session compaction aborted by signal');
    }
    const summaryText = budget.summaryTokens
      ? truncateToTokenBudget(generatedSummary, budget.summaryTokens, this.config.charsPerToken)
      : generatedSummary;

    const fullSummaryContent = formattedState
      ? `【Context Summary / 会话前情提要】\n${summaryText}\n\n【Runtime State】\n${formattedState}`
      : `【Context Summary / 会话前情提要】\n${summaryText}`;

    const entry: CompactionEntry = {
      id: `compaction_${this.clock()}`,
      type: 'compaction',
      summary: summaryText,
      firstKeptEntryId: keptMessages[0]?.id || 'kept_first',
      tokensBefore,
      estimatedTokensAfter:
        this.estimateTokens(keptMessages) + Math.ceil(fullSummaryContent.length * this.config.charsPerToken),
      createdAt: this.clock(),
      details: runtimeState ? { runtimeState } : undefined
    };

    // Replace old messages with structured summary block
    const summaryAssistantMessage: AssistantMessage = {
      id: entry.id,
      role: 'assistant',
      content: [{ type: 'text', text: fullSummaryContent }],
      stopReason: 'stop',
      timestamp: this.clock()
    };

    const compactedMessages: AgentMessage[] = [summaryAssistantMessage, ...keptMessages];

    return {
      compactedMessages,
      entry,
      budget
    };
  }

  private findSplitIndex(messages: AgentMessage[], budget: CompactionBudget): number {
    let splitIndex = Math.max(1, messages.length - budget.preserveRecentCount);
    if (budget.preserveRecentTokens === undefined) return splitIndex;

    let retainedTokens = 0;
    let retainedCount = 0;
    while (
      splitIndex > 0 &&
      (retainedCount < budget.preserveRecentCount || retainedTokens < budget.preserveRecentTokens)
    ) {
      splitIndex -= 1;
      retainedCount += 1;
      retainedTokens += this.estimateMessageTokens(messages[splitIndex]);
    }
    return Math.max(1, splitIndex);
  }
}

function positiveNumberOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function positiveIntegerOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback;
}

function positiveIntegerOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeIntegerOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function nonNegativeIntegerOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function estimateContentValue(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (!Array.isArray(value)) return estimateJsonValue(value);

  return value.reduce((total: number, block: unknown) => {
    if (!block || typeof block !== 'object') return total + estimateJsonValue(block);
    const record = block as Record<string, unknown>;
    switch (record.type) {
      case 'text':
        return total + estimateTextValue(record.text);
      case 'thinking':
        return total + estimateTextValue(record.thinking);
      case 'image':
        return total + estimateTextValue(record.image) + estimateTextValue(record.mimeType);
      case 'toolCall':
        return (
          total + estimateTextValue(record.id) + estimateTextValue(record.name) + estimateJsonValue(record.arguments)
        );
      default:
        return total + estimateJsonValue(record);
    }
  }, 0);
}

function estimateTextValue(value: unknown): number {
  return typeof value === 'string' ? value.length : 0;
}

function estimateJsonValue(value: unknown): number {
  if (value === undefined) return 0;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return '[unserializable]'.length;
  }
}

function truncateToTokenBudget(text: string, tokenBudget: number, charsPerToken: number): string {
  const maxCharacters = Math.max(1, Math.floor(tokenBudget / charsPerToken));
  if (text.length <= maxCharacters) return text;

  const suffix = '… (truncated)';
  if (maxCharacters <= suffix.length) return text.slice(0, maxCharacters);
  return `${text.slice(0, maxCharacters - suffix.length)}${suffix}`;
}
