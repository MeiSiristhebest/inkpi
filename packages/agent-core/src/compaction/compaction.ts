import type { AgentMessage, CompactionEntry, AssistantMessage } from '@inkpi/protocol';
import { serializeConversationForSummary, GENERIC_SUMMARIZATION_SYSTEM_PROMPT } from './utils.js';
import { extractStateLedger, formatStateLedger } from './state-ledger.js';

export interface CompactionConfig {
  /** Trigger threshold in tokens (e.g. 100,000) */
  triggerTokensThreshold?: number;
  /** Number of recent messages to preserve after compaction (e.g. 4) */
  preserveRecentCount?: number;
  /** Custom summarizer function */
  summarizer?: (serializedConversation: string, systemPrompt: string) => Promise<string>;
}

export class SessionCompactor {
  private config: Required<CompactionConfig>;

  constructor(config: CompactionConfig = {}) {
    this.config = {
      triggerTokensThreshold: config.triggerTokensThreshold ?? 50000,
      preserveRecentCount: config.preserveRecentCount ?? 4,
      summarizer: config.summarizer ?? (async (conv) => `[Summary]\n${conv.slice(0, 300)}...`)
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
        total += Math.ceil(str.length * 0.7);
      } else if (msg.role === 'assistant') {
        for (const b of msg.content) {
          if (b.type === 'text') total += Math.ceil(b.text.length * 0.7);
          if (b.type === 'thinking') total += Math.ceil(b.thinking.length * 0.7);
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
    const tokensBefore = this.estimateTokens(messages);
    const splitIndex = Math.max(1, messages.length - this.config.preserveRecentCount);

    const oldMessages = messages.slice(0, splitIndex);
    const keptMessages = messages.slice(splitIndex);

    // Extract state ledger from compacted range
    const stateLedger = extractStateLedger(oldMessages);
    const formattedLedger = formatStateLedger(stateLedger);

    // Generate conversation summary
    const serialized = serializeConversationForSummary(oldMessages);
    const summaryText = await this.config.summarizer(serialized, GENERIC_SUMMARIZATION_SYSTEM_PROMPT);

    const fullSummaryContent = formattedLedger
      ? `【Context Summary / 会话前情提要】\n${summaryText}\n\n【State Ledger / 核心状态账本】\n${formattedLedger}`
      : `【Context Summary / 会话前情提要】\n${summaryText}`;

    const entry: CompactionEntry = {
      id: `compaction_${Date.now()}`,
      type: 'compaction',
      summary: summaryText,
      firstKeptEntryId: keptMessages[0]?.id || 'kept_first',
      tokensBefore,
      estimatedTokensAfter: this.estimateTokens(keptMessages) + Math.ceil(fullSummaryContent.length * 0.7),
      createdAt: Date.now(),
      details: { stateLedger }
    };

    // Replace old messages with structured summary block
    const summaryAssistantMessage: AssistantMessage = {
      id: entry.id,
      role: 'assistant',
      content: [
        { type: 'text', text: fullSummaryContent }
      ],
      stopReason: 'stop',
      timestamp: Date.now()
    };

    const compactedMessages: AgentMessage[] = [summaryAssistantMessage, ...keptMessages];

    return {
      compactedMessages,
      entry
    };
  }
}
