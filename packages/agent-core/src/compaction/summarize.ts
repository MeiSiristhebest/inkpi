import { CHARS_PER_TOKEN_HEURISTIC } from '@inkpi/ai';
import type { AgentMessage, ContentBlock, ImageContent, Usage } from '@inkpi/protocol';

export const GENERIC_SUMMARIZATION_SYSTEM_PROMPT = `
You are an expert at compressing visible conversation history into high-fidelity summaries.
Your task is to summarize the conversation text and tool activity provided to you. Hidden reasoning is not included.

Please extract and retain:
1. Core intent and instructions from the user.
2. Major decisions, constraints, or conclusions reached.
3. Important tool calls, results, and references that support those conclusions.
4. Pending or unresolved items/tasks.
5. Essential context needed for the agent to continue seamlessly.

Output should be concise, well-structured, and provide seamless continuity for the agent.
`.trim();

/** Safety defaults for call sites that do not yet provide a model/task-specific budget. */
export const SUMMARY_SERIALIZATION_DEFAULTS = Object.freeze({
  maxInputTokens: 16_000,
  maxToolResultTokens: 2_000,
  maxToolCallArgumentTokens: 1_000
});

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export interface SummarySerializationOptions {
  /** Estimated-token cap for the complete serialized conversation, not a model context capability. */
  maxInputTokens?: number;
  /** Estimated-token cap applied to each tool result before the whole-input cap. */
  maxToolResultTokens?: number;
  /** Estimated-token cap for each tool call's arguments. */
  maxToolCallArgumentTokens?: number;
  /** Character-to-token estimate shared with the request budget accounting. */
  charsPerToken?: number;
}

/** Budget facts the caller actually knows; optional model capabilities stay unknown. */
export interface SummaryGenerationRequest {
  signal?: AbortSignal;
  /** Estimated serialized input ceiling applied by the Runtime. */
  maxInputTokens: number;
  /** Estimated serialized input plus prompt overhead known to the caller. */
  estimatedInputTokens: number;
  /** Only populated when the caller knows the summarizer model's context window. */
  contextWindowTokens?: number;
  /** Approximate context remaining after input and system prompt. */
  remainingContextTokens?: number;
  /** Requested total generation cap (including separately reported reasoning tokens), when known. */
  maxOutputTokens?: number;
  /** Stable task kind, without task payload or private user data. */
  taskKind?: string;
}

export interface SummaryGenerationResult {
  text: string;
  /** Provider-reported usage. Missing usage is not interpreted as zero. */
  usage?: Usage;
}

export type SummaryGenerationOutput = string | SummaryGenerationResult;

/** Shared estimate used for summary budgets; this is not provider-tokenizer output. */
export function estimateSummaryTokens(text: string, charsPerToken = CHARS_PER_TOKEN_HEURISTIC): number {
  const factor = positiveNumber(charsPerToken, CHARS_PER_TOKEN_HEURISTIC);
  return Math.ceil(text.length * factor);
}

/** Apply a legacy visible-summary ceiling with an explicit marker and grapheme-safe boundaries. */
export function truncateSummaryText(
  text: string,
  tokenBudget: number,
  charsPerToken = CHARS_PER_TOKEN_HEURISTIC
): string {
  const factor = positiveNumber(charsPerToken, CHARS_PER_TOKEN_HEURISTIC);
  const maxChars = tokenLimitToChars(positiveInteger(tokenBudget, 1), factor);
  return truncateWithMarker(text, maxChars, 'SUMMARY OUTPUT');
}

/** Provider usage can distinguish cache tokens from input tokens and reasoning from visible output. */
export function reportedSummaryInputTokens(usage: Usage): number {
  return usage.promptTokens ?? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
}

export function reportedSummaryOutputTokens(usage: Usage): number {
  return usage.outputTokens + (usage.reasoningTokens ?? 0);
}

/**
 * Serialize visible conversation data for a summarizer without mutating source history.
 * Thinking blocks and image bytes are intentionally excluded. Oversized tool payloads
 * and the final transcript receive explicit omission markers and retain both ends.
 */
export function serializeConversationForSummary(
  messages: AgentMessage[],
  options: SummarySerializationOptions = {}
): string {
  const charsPerToken = positiveNumber(options.charsPerToken, CHARS_PER_TOKEN_HEURISTIC);
  const maxInputChars = tokenLimitToChars(
    positiveInteger(options.maxInputTokens, SUMMARY_SERIALIZATION_DEFAULTS.maxInputTokens),
    charsPerToken
  );
  const maxToolResultChars = tokenLimitToChars(
    positiveInteger(options.maxToolResultTokens, SUMMARY_SERIALIZATION_DEFAULTS.maxToolResultTokens),
    charsPerToken
  );
  const maxToolCallArgumentChars = tokenLimitToChars(
    positiveInteger(options.maxToolCallArgumentTokens, SUMMARY_SERIALIZATION_DEFAULTS.maxToolCallArgumentTokens),
    charsPerToken
  );

  const parts = messages
    .map((message) => serializeMessage(message, maxToolResultChars, maxToolCallArgumentChars))
    .filter((part) => part.length > 0);
  return truncateWithMarker(parts.join('\n\n'), maxInputChars, 'SUMMARY INPUT');
}

function serializeMessage(message: AgentMessage, maxToolResultChars: number, maxToolCallArgumentChars: number): string {
  const id = message.id ? ` id=${message.id}` : '';
  switch (message.role) {
    case 'user':
      return `[USER${id}]: ${serializeUserContent(message.content)}`;
    case 'assistant': {
      const parts = message.content.flatMap((block) => {
        if (block.type === 'text') return [`[AI RESPONSE${id}]: ${block.text}`];
        if (block.type === 'toolCall') {
          const args = truncateWithMarker(
            safeJson(block.arguments),
            maxToolCallArgumentChars,
            `TOOL CALL ${block.name} ARGUMENTS`
          );
          return [`[TOOL CALL${id}]: ${block.name} callId=${block.id} arguments=${args}`];
        }
        if (block.type === 'image') return [`[AI IMAGE${id}]: ${describeImage(block)}`];
        // Hidden model reasoning is not part of the summary request.
        return [];
      });
      return parts.join('\n');
    }
    case 'toolResult': {
      const content = serializeContentBlocks(message.content);
      const details = message.details === undefined ? '' : `\nDetails: ${safeJson(message.details)}`;
      const error = message.isError ? ' error=true' : '';
      const body = `[TOOL RESULT${id}]: ${message.toolName} callId=${message.toolCallId}${error}\n${content}${details}`;
      return truncateWithMarker(body, maxToolResultChars, `TOOL RESULT ${message.toolName}`);
    }
    case 'system': {
      const sections = message.sections === undefined ? '' : `\nSections: ${safeJson(message.sections)}`;
      const toolsAdded = message.toolsAdded?.length
        ? `\nTools added: ${message.toolsAdded.map((tool) => `${tool.name}: ${tool.description}`).join('; ')}`
        : '';
      const toolsRemoved = message.toolsRemoved?.length
        ? `\nTools removed: ${message.toolsRemoved.map((tool) => tool.name).join(', ')}`
        : '';
      return `[SYSTEM${id}]: ${message.content}${sections}${toolsAdded}${toolsRemoved}`;
    }
    case 'custom':
      return `[CUSTOM ${message.customType}${id}]: ${safeJson(message.content)}`;
    default:
      throw new TypeError('Unsupported message role in summary serialization.');
  }
}

function serializeUserContent(content: string | Array<{ type: 'text'; text: string } | ImageContent>): string {
  if (typeof content === 'string') return content;
  return content.map((block) => (block.type === 'text' ? block.text : `[IMAGE: ${describeImage(block)}]`)).join('\n');
}

function serializeContentBlocks(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === 'text') return block.text;
      if (block.type === 'image') return `[IMAGE: ${describeImage(block)}]`;
      if (block.type === 'toolCall') return `[TOOL CALL ${block.name}]: ${safeJson(block.arguments)}`;
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function describeImage(image: ImageContent): string {
  return `bytes omitted; mimeType=${image.mimeType ?? 'unknown'}; encodedChars=${image.image.length}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '[unserializable value]';
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function tokenLimitToChars(tokenLimit: number, charsPerToken: number): number {
  return Math.max(1, Math.floor(tokenLimit / charsPerToken));
}

function truncateWithMarker(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) return text;

  const safeLabel = prefixByGrapheme(label.replace(/[\r\n\u0000-\u001f]/g, ' '), 80);
  const marker = `…[${safeLabel}: original=${text.length} chars; truncated]…`;
  if (maxChars <= marker.length) {
    const compactMarker = `[omitted ${text.length} chars]`;
    return compactMarker.length <= maxChars ? compactMarker : prefixByGrapheme(compactMarker, maxChars);
  }

  const contentChars = maxChars - marker.length;
  const headChars = Math.ceil(contentChars * 0.7);
  const tailChars = contentChars - headChars;
  return `${prefixByGrapheme(text, headChars)}${marker}${suffixByGrapheme(text, tailChars)}`;
}

function prefixByGrapheme(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  let result = '';
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    if (result.length + segment.length > maxChars) break;
    result += segment;
  }
  return result;
}

function suffixByGrapheme(text: string, maxChars: number): string {
  if (maxChars <= 0) return '';
  const suffix: string[] = [];
  let start = 0;
  let length = 0;
  for (const { segment } of GRAPHEME_SEGMENTER.segment(text)) {
    if (segment.length > maxChars) {
      suffix.length = 0;
      start = 0;
      length = 0;
      continue;
    }
    suffix.push(segment);
    length += segment.length;
    while (length > maxChars) length -= suffix[start++].length;
    if (start > 4096) {
      suffix.splice(0, start);
      start = 0;
    }
  }
  return suffix.slice(start).join('');
}
