import { CHARS_PER_TOKEN_HEURISTIC } from '@inkpi/ai';
import type { AgentMessage, AssistantMessage, CompactionEntry } from '@inkpi/protocol';
import type { Clock } from '../ports/index.js';
import { type LedgerExtractor, extractStateLedger } from './state-ledger.js';
import { GENERIC_SUMMARIZATION_SYSTEM_PROMPT, serializeConversationForSummary } from './summarize.js';

export interface CompactionConfig {
  /** Trigger threshold in tokens (e.g. 100,000) */
  triggerTokensThreshold?: number;
  /** Number of recent messages to preserve after compaction (e.g. 4) */
  preserveRecentCount?: number;
  /** Custom summarizer function */
  summarizer?: (serializedConversation: string, systemPrompt: string) => Promise<string>;
  /** Optional domain adapter for extracting structured state from compacted messages. */
  ledgerExtractors?: LedgerExtractor[];
  /** Optional domain adapter for rendering the extracted state into the summary message. */
  ledgerFormatter?: (ledger: ReturnType<typeof extractStateLedger>) => string;
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
  preserveRecentCount: number;
  summarizer?: CompactionConfig['summarizer'];
  ledgerExtractors?: LedgerExtractor[];
  ledgerFormatter?: CompactionConfig['ledgerFormatter'];
}

export class SessionCompactor {
  private config: ResolvedCompactionConfig;
  private clock: Clock;

  constructor(config: CompactionConfig) {
    this.clock = config.clock;
    this.config = {
      triggerTokensThreshold: config.triggerTokensThreshold ?? 50000,
      preserveRecentCount: config.preserveRecentCount ?? 4,
      summarizer: config.summarizer,
      ledgerExtractors: config.ledgerExtractors,
      ledgerFormatter: config.ledgerFormatter,
      charsPerToken: config.charsPerToken ?? CHARS_PER_TOKEN_HEURISTIC
    };
  }

  /**
   * Roughly estimate total tokens in the message queue
   */
  public estimateTokens(messages: AgentMessage[]): number {
    let total = 0;
    for (const msg of messages) {
      if (msg.role === 'user') {
        const str = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        total += Math.ceil(str.length * this.config.charsPerToken);
      } else if (msg.role === 'assistant') {
        for (const b of msg.content) {
          if (b.type === 'text') total += Math.ceil(b.text.length * this.config.charsPerToken);
          if (b.type === 'thinking') total += Math.ceil(b.thinking.length * this.config.charsPerToken);
        }
      }
    }
    return total;
  }

  /**
   * Check if compaction should be triggered
   */
  public shouldCompact(messages: AgentMessage[]): boolean {
    if (messages.length <= this.config.preserveRecentCount + 2) return false;
    return this.estimateTokens(messages) >= this.config.triggerTokensThreshold;
  }

  /**
   * Execute atomic context compaction (1:1 aligned with repos/pi compact)
   */
  public async compact(messages: AgentMessage[]): Promise<{
    compactedMessages: AgentMessage[];
    entry: CompactionEntry;
  }> {
    if (!this.config.summarizer) {
      throw new Error('Session compaction requires an explicit summarizer capability.');
    }

    const tokensBefore = this.estimateTokens(messages);
    const splitIndex = Math.max(1, messages.length - this.config.preserveRecentCount);

    const oldMessages = messages.slice(0, splitIndex);
    const keptMessages = messages.slice(splitIndex);

    const stateLedger = this.config.ledgerExtractors
      ? extractStateLedger(oldMessages, this.config.ledgerExtractors)
      : undefined;
    const formattedLedger = stateLedger && this.config.ledgerFormatter ? this.config.ledgerFormatter(stateLedger) : '';

    // Generate conversation summary
    const serialized = serializeConversationForSummary(oldMessages);
    const summaryText = await this.config.summarizer(serialized, GENERIC_SUMMARIZATION_SYSTEM_PROMPT);

    const fullSummaryContent = formattedLedger
      ? `【Context Summary / 会话前情提要】\n${summaryText}\n\n【State Ledger / 核心状态账本】\n${formattedLedger}`
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
      details: stateLedger ? { stateLedger } : undefined
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
      entry
    };
  }
}
