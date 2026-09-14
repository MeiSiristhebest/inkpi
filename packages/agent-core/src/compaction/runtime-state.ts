import type { AgentMessage, RuntimeState } from '@inkpi/protocol';

export type { RuntimeState } from '@inkpi/protocol';

/**
 * Opaque state extraction context supplied to an explicit adapter.
 *
 * The Runtime only carries this state across compaction.  It does not parse
 * product-domain tags, tool names, or document semantics by default.
 */
export interface RuntimeStateExtractorContext {
  messages: AgentMessage[];
  state: RuntimeState;
}

/** A caller-owned adapter for deriving opaque state from conversation text. */
export interface RuntimeStateExtractor {
  id: string;
  extract(rawText: string, context: RuntimeStateExtractorContext, message: AgentMessage): void;
}

/**
 * Apply only explicitly supplied state extractors.
 *
 * An empty extractor list returns an empty object, which keeps the generic
 * Runtime free of product-domain defaults.
 */
export function extractRuntimeState(
  messages: AgentMessage[],
  extractors: readonly RuntimeStateExtractor[] = []
): RuntimeState {
  const state: RuntimeState = {};
  const context: RuntimeStateExtractorContext = { messages, state };

  for (const message of messages) {
    const rawText = messageText(message);
    for (const extractor of extractors) extractor.extract(rawText, context, message);
  }

  return state;
}

/** Render opaque state only when a caller requests the generic fallback. */
export function formatRuntimeState(state?: RuntimeState, formatter?: (state: RuntimeState) => string): string {
  if (!state) return '';
  if (formatter) return formatter(state);

  const keys = Object.keys(state).sort();
  if (keys.length === 0) return '';

  try {
    return JSON.stringify(state, keys) || '';
  } catch {
    return '';
  }
}

function messageText(message: AgentMessage): string {
  if (message.role === 'user' || message.role === 'system' || message.role === 'custom') {
    return typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  }
  if (message.role === 'toolResult') return JSON.stringify(message.content);
  return message.content
    .filter((block) => block.type === 'text' || block.type === 'thinking')
    .map((block) => (block.type === 'text' ? block.text : block.thinking))
    .join(' ');
}
