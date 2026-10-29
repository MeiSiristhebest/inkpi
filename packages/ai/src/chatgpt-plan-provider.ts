import type { AgentMessage, ImageContent, Usage } from '@inkpi/protocol';
import { ProviderError, classifyProviderError } from './errors.js';
import { getHttpClient } from './http-client.js';
import { sanitizeMessagesForProvider } from './sanitize.js';
import { AssistantEventStream } from './stream.js';
import { resolveModelTranscript } from './transcript.js';
import type { ModelConfig, StreamFn, StreamOptions } from './types.js';

const PROVIDER = 'openai-chatgpt-plan';
const RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';

type ResponsesInputContent = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string };

interface FunctionCallState {
  itemId: string;
  callId: string;
  name: string;
  arguments: string;
  finalized: boolean;
}

/** ChatGPT plan accounts use the Responses API, never the API-key Chat Completions path. */
export const chatGPTPlanResponsesProvider: StreamFn = (model, inputMessages, inputOptions) => {
  const stream = new AssistantEventStream();
  const apiKey = model.apiKey?.trim();
  if (!apiKey) {
    queueMicrotask(() => {
      stream.error(
        new ProviderError({
          code: 'authentication',
          provider: PROVIDER,
          message: 'The selected ChatGPT account did not provide an access token.'
        })
      );
    });
    return stream;
  }

  const { messages, options } = resolveModelTranscript(
    inputMessages,
    inputOptions,
    model.compat?.supportsMidConvoSystemMessages === true
  );
  const sanitizedMessages = sanitizeMessagesForProvider(messages, model);
  const body = buildRequestBody(model, sanitizedMessages, options);

  void (async () => {
    try {
      const response = await getHttpClient().fetch(RESPONSES_ENDPOINT, {
        method: 'POST',
        headers: {
          Accept: 'text/event-stream',
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: options?.signal
      });
      if (!response.ok) {
        const details = await readErrorBody(response);
        const message = errorMessage(details) ?? `OpenAI Responses API error (HTTP ${response.status}).`;
        const retryAfter = response.headers.get('retry-after');
        const retryAfterMs = retryAfter ? Math.max(0, Number(retryAfter) * 1000) : undefined;
        stream.error(
          classifyProviderError(new Error(message), {
            provider: PROVIDER,
            status: response.status,
            retryAfterMs,
            details
          })
        );
        return;
      }
      if (!response.body) {
        stream.error(
          new ProviderError({
            code: 'malformed_response',
            provider: PROVIDER,
            message: 'OpenAI Responses API returned no event stream.'
          })
        );
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawCompleted = false;
      let sawDone = false;
      let sawText = false;
      let sawOutput = false;
      const callsByItemId = new Map<string, FunctionCallState>();

      const processEvent = (rawEvent: string): void => {
        let eventName = '';
        const dataLines: string[] = [];
        for (const line of rawEvent.split(/\r?\n/)) {
          if (!line || line.startsWith(':')) continue;
          const separator = line.indexOf(':');
          const field = separator < 0 ? line : line.slice(0, separator);
          const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
          if (field === 'event') eventName = value;
          else if (field === 'data') dataLines.push(value);
        }
        if (dataLines.length === 0) return;
        const dataText = dataLines.join('\n').trim();
        if (dataText === '[DONE]') {
          sawDone = true;
          return;
        }
        const data = parseEventJson(dataText);
        const type = typeof data.type === 'string' ? data.type : eventName;

        if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
          if (typeof data.delta === 'string' && data.delta) {
            sawText = true;
            sawOutput = true;
            stream.push({ type: 'text_delta', textDelta: data.delta });
          }
          return;
        }
        if (type === 'response.reasoning_summary_text.delta') {
          if (typeof data.delta === 'string' && data.delta) {
            sawOutput = true;
            stream.push({ type: 'thinking_delta', thinkingDelta: data.delta });
          }
          return;
        }
        if (type === 'response.output_item.added' || type === 'response.output_item.done') {
          const item = asRecord(data.item);
          if (item?.type === 'function_call') {
            const state = registerFunctionCall(item, callsByItemId, stream);
            if (type === 'response.output_item.done') finalizeFunctionCall(state, item.arguments, stream);
          }
          if (type === 'response.output_item.done' && item?.type === 'message' && !sawText) {
            emitFinalMessageText(item, stream, () => {
              sawText = true;
              sawOutput = true;
            });
          }
          return;
        }
        if (type === 'response.function_call_arguments.delta') {
          const itemId = typeof data.item_id === 'string' ? data.item_id : '';
          const state = callsByItemId.get(itemId);
          if (!state || typeof data.delta !== 'string') {
            throw malformed('OpenAI Responses API returned function arguments without a call.');
          }
          state.arguments += data.delta;
          if (data.delta) {
            sawOutput = true;
            stream.push({ type: 'tool_call_delta', toolCallId: state.callId, argsDelta: data.delta });
          }
          return;
        }
        if (type === 'response.function_call_arguments.done') {
          const itemId = typeof data.item_id === 'string' ? data.item_id : '';
          const state = callsByItemId.get(itemId);
          if (!state) throw malformed('OpenAI Responses API returned an unknown function call.');
          finalizeFunctionCall(state, data.arguments, stream);
          sawOutput = true;
          return;
        }
        if (type === 'response.completed') {
          const responseRecord = asRecord(data.response);
          if (responseRecord) {
            emitUsage(responseRecord.usage, stream);
            if (!sawText && Array.isArray(responseRecord.output)) {
              for (const itemValue of responseRecord.output) {
                const item = asRecord(itemValue);
                if (item?.type === 'message') {
                  emitFinalMessageText(item, stream, () => {
                    sawText = true;
                    sawOutput = true;
                  });
                } else if (item?.type === 'function_call') {
                  const state = registerFunctionCall(item, callsByItemId, stream);
                  finalizeFunctionCall(state, item.arguments, stream);
                  sawOutput = true;
                }
              }
            } else if (Array.isArray(responseRecord.output)) {
              for (const itemValue of responseRecord.output) {
                const item = asRecord(itemValue);
                if (item?.type !== 'function_call') continue;
                const state = registerFunctionCall(item, callsByItemId, stream);
                finalizeFunctionCall(state, item.arguments, stream);
                sawOutput = true;
              }
            }
          }
          sawCompleted = true;
          return;
        }
        if (type === 'response.failed' || type === 'error') {
          const responseRecord = asRecord(data.response);
          const failure = asRecord(responseRecord?.error) ?? asRecord(data.error);
          const message =
            typeof failure?.message === 'string' ? failure.message : 'OpenAI Responses API request failed.';
          throw classifyProviderError(new Error(message), { provider: PROVIDER });
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = findEventBoundary(buffer);
        while (boundary) {
          processEvent(buffer.slice(0, boundary.index));
          buffer = buffer.slice(boundary.index + boundary.length);
          boundary = findEventBoundary(buffer);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) processEvent(buffer);
      for (const state of callsByItemId.values()) {
        if (!state.finalized) finalizeFunctionCall(state, undefined, stream);
      }
      if (!sawCompleted) {
        throw malformed(
          sawDone
            ? 'OpenAI Responses API stream ended before response.completed.'
            : 'OpenAI Responses API stream ended unexpectedly.'
        );
      }
      if (!sawOutput) throw malformed('OpenAI Responses API completed without assistant output.');
      stream.end();
    } catch (error: unknown) {
      if (isAbortError(error)) stream.abort();
      else stream.error(classifyProviderError(error, { provider: PROVIDER }));
    }
  })();

  return stream;
};

function buildRequestBody(
  model: ModelConfig,
  messages: AgentMessage[],
  options?: StreamOptions
): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  if (options?.systemPrompt) input.push({ role: 'developer', content: options.systemPrompt });
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) input.push({ role: 'developer', content: message.content });
    } else if (message.role === 'user') {
      const content = typeof message.content === 'string' ? message.content : userContent(message.content);
      if (content) input.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      const text = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      if (text) input.push({ role: 'assistant', content: text });
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue;
        input.push({
          type: 'function_call',
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.arguments)
        });
      }
    } else if (message.role === 'toolResult') {
      const output = message.content
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('');
      input.push({ type: 'function_call_output', call_id: message.toolCallId, output });
    }
  }

  const body: Record<string, unknown> = {
    model: model.id,
    input,
    stream: true,
    store: false
  };
  const maxOutputTokens = options?.maxTokens ?? model.maxTokens;
  if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    body.max_output_tokens = Math.floor(maxOutputTokens);
  }
  if (typeof model.temperature === 'number' && Number.isFinite(model.temperature)) {
    body.temperature = model.temperature;
  }
  if (options?.tools?.length) {
    body.tools = options.tools.map((tool) => ({
      type: 'function',
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }));
  }
  return body;
}

function userContent(content: Array<{ type: 'text'; text: string } | ImageContent>): ResponsesInputContent[] {
  const result: ResponsesInputContent[] = [];
  for (const block of content) {
    if (block.type === 'text') {
      if (block.text) result.push({ type: 'input_text', text: block.text });
    } else {
      result.push({ type: 'input_image', image_url: imageUrl(block) });
    }
  }
  return result;
}

function imageUrl(image: ImageContent): string {
  if (/^(?:https?:|data:)/i.test(image.image)) return image.image;
  const mimeType = image.mimeType && /^image\/[a-z0-9.+-]+$/i.test(image.mimeType) ? image.mimeType : 'image/png';
  return `data:${mimeType};base64,${image.image}`;
}

function registerFunctionCall(
  item: Record<string, unknown>,
  callsByItemId: Map<string, FunctionCallState>,
  stream: AssistantEventStream
): FunctionCallState {
  const callId = typeof item.call_id === 'string' ? item.call_id : '';
  const itemId = typeof item.id === 'string' ? item.id : callId;
  const name = typeof item.name === 'string' ? item.name : '';
  if (!callId || !itemId || !name) throw malformed('OpenAI Responses API returned an incomplete function call.');
  let state = callsByItemId.get(itemId);
  if (!state) {
    state = { itemId, callId, name, arguments: '', finalized: false };
    callsByItemId.set(itemId, state);
    stream.push({ type: 'tool_call_start', toolCallId: callId, toolName: name });
  } else if (state.callId !== callId || state.name !== name) {
    throw malformed('OpenAI Responses API changed a function call identity mid-stream.');
  }
  if (typeof item.arguments === 'string' && !state.arguments && item.arguments) {
    state.arguments = item.arguments;
    stream.push({ type: 'tool_call_delta', toolCallId: callId, argsDelta: item.arguments });
  }
  return state;
}

function finalizeFunctionCall(state: FunctionCallState, finalArguments: unknown, stream: AssistantEventStream): void {
  if (state.finalized) return;
  if (typeof finalArguments === 'string' && state.arguments !== finalArguments) {
    if (!finalArguments.startsWith(state.arguments)) {
      throw malformed('OpenAI Responses API function arguments did not match the streamed deltas.');
    }
    const missing = finalArguments.slice(state.arguments.length);
    state.arguments = finalArguments;
    if (missing) stream.push({ type: 'tool_call_delta', toolCallId: state.callId, argsDelta: missing });
  }
  let argumentsValue: Record<string, unknown>;
  try {
    const parsed: unknown = state.arguments ? JSON.parse(state.arguments) : {};
    if (!isRecord(parsed)) throw new Error('arguments must be an object');
    argumentsValue = parsed;
  } catch {
    throw malformed(`OpenAI Responses API returned invalid arguments for '${state.name}'.`);
  }
  stream.push({
    type: 'tool_call_end',
    toolCall: { type: 'toolCall', id: state.callId, name: state.name, arguments: argumentsValue }
  });
  state.finalized = true;
}

function emitFinalMessageText(item: Record<string, unknown>, stream: AssistantEventStream, onOutput: () => void): void {
  if (!Array.isArray(item.content)) return;
  for (const blockValue of item.content) {
    const block = asRecord(blockValue);
    if (!block || (block.type !== 'output_text' && block.type !== 'refusal') || typeof block.text !== 'string')
      continue;
    if (!block.text) continue;
    onOutput();
    stream.push({ type: 'text_delta', textDelta: block.text });
  }
}

function emitUsage(value: unknown, stream: AssistantEventStream): void {
  const usageRecord = asRecord(value);
  if (!usageRecord) return;
  const inputTokens = finiteNonNegative(usageRecord.input_tokens);
  const outputTokens = finiteNonNegative(usageRecord.output_tokens);
  const totalTokens = finiteNonNegative(usageRecord.total_tokens, inputTokens + outputTokens);
  const inputDetails = asRecord(usageRecord.input_tokens_details);
  const outputDetails = asRecord(usageRecord.output_tokens_details);
  const cacheReadTokens = finiteNonNegative(inputDetails?.cached_tokens);
  const reasoningTokens = finiteNonNegative(outputDetails?.reasoning_tokens);
  const usage: Usage = {
    inputTokens: Math.max(0, inputTokens - cacheReadTokens),
    outputTokens,
    totalTokens,
    promptTokens: inputTokens,
    cacheReadTokens,
    ...(reasoningTokens > 0 ? { reasoningTokens } : {})
  };
  stream.push({ type: 'usage', usage });
}

async function readErrorBody(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    try {
      const text = await response.clone().text();
      return text ? { message: text.slice(0, 500) } : undefined;
    } catch {
      return undefined;
    }
  }
}

function errorMessage(value: unknown): string | undefined {
  const record = asRecord(value);
  const nestedError = asRecord(record?.error);
  if (typeof nestedError?.message === 'string') return nestedError.message;
  if (typeof record?.message === 'string') return record.message;
  return undefined;
}

function parseEventJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    const record = asRecord(parsed);
    if (!record) throw new Error('event is not an object');
    return record;
  } catch {
    throw malformed('OpenAI Responses API returned a malformed stream event.');
  }
}

function findEventBoundary(value: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}

function malformed(message: string): ProviderError {
  return new ProviderError({ code: 'malformed_response', provider: PROVIDER, message, retryable: false });
}

function finiteNonNegative(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return asRecord(value) !== undefined;
}

function isAbortError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError');
}
