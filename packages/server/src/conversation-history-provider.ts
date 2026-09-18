import type { ContextProvider } from '@inkpi/agent-core';
import { stableSerialize } from '@inkpi/agent-core';

/**
 * Injects multi-turn conversation history sent by the Desktop in
 * `task.input.payload.conversationHistory` into the context pipeline.
 *
 * The Desktop bundles up to 6 recent turns via `sendAiPrompt` →
 * `createAssistantTask({ conversationHistory: rollingHistory })`, which
 * spreads into `task.input.payload` (see taskFactories.ts line 246).
 *
 * The fragment is emitted as `kind: 'conversation-history'` at priority 850
 * (above story-state 700, below document 800 → between them to preserve
 * recency without displacing the open document from the top slot).
 */
export const CONVERSATION_HISTORY_PROVIDER_ID = 'creative.conversation-history';

export interface ConversationTurn {
  role: 'user' | 'assistant';
  text: string;
}

function extractHistory(payload: unknown): ConversationTurn[] | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const raw = (payload as Record<string, unknown>).conversationHistory;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const turns: ConversationTurn[] = [];
  for (const entry of raw) {
    if (
      entry &&
      typeof entry === 'object' &&
      (entry.role === 'user' || entry.role === 'assistant') &&
      typeof entry.text === 'string' &&
      entry.text.trim().length > 0
    ) {
      turns.push({ role: entry.role as 'user' | 'assistant', text: entry.text });
    }
  }
  return turns.length > 0 ? turns : undefined;
}

export function createConversationHistoryProvider(): ContextProvider {
  return {
    id: CONVERSATION_HISTORY_PROVIDER_ID,
    supports: ({ task }) => extractHistory(task.input.payload) !== undefined,
    provide: ({ task }) => {
      const turns = extractHistory(task.input.payload);
      if (!turns) return [];
      return [
        {
          id: `creative.conversation-history:${hash(stableSerialize(turns))}`,
          source: CONVERSATION_HISTORY_PROVIDER_ID,
          kind: 'conversation-history',
          data: { turns },
          priority: 850,
          dependency: 0,
        },
      ];
    },
  };
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}
