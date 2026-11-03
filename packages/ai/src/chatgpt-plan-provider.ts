import type { AgentMessage, ImageContent, Usage } from '@inkpi/protocol';
import { ProviderError, classifyProviderError } from './errors.js';
import { getHttpClient } from './http-client.js';
import { sanitizeMessagesForProvider } from './sanitize.js';
import { AssistantEventStream } from './stream.js';
import { resolveModelTranscript } from './transcript.js';
import type { ModelConfig, StreamFn, StreamOptions } from './types.js';

const CHATGPT_PLAN_RESPONSES_ENDPOINT = 'https://api.openai.com/v1/responses';
const OPENAI_RESPONSES_BASE_URL = 'https://api.openai.com/v1';
const CODEX_BASE_URL = 'https://chatgpt.com/backend-api';
const OPENAI_ACCOUNT_CLAIM = 'https://api.openai.com/auth';

type ResponsesProviderConfig = {
  provider: 'openai-chatgpt-plan' | 'openai-responses' | 'azure-openai-responses' | 'openai-codex';
  transport: 'account' | 'api-key' | 'azure-key' | 'codex';
  apiKeyEnv?: string;
};

type ResponsesInputContent = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string };

interface FunctionCallState {
  provider: string;
  itemId: string;
  callId: string;
  name: string;
  argumentChunks: string[];
  blockIndex?: number;
  finalized: boolean;
}

/** OpenAI Responses routes remain separate from ChatGPT Plan and Codex account auth. */
export const chatGPTPlanResponsesProvider = createResponsesProvider({
  provider: 'openai-chatgpt-plan',
  transport: 'account'
});
export const openAIResponsesProvider = createResponsesProvider({
  provider: 'openai-responses',
  transport: 'api-key',
  apiKeyEnv: 'OPENAI_API_KEY'
});
export const azureOpenAIResponsesProvider = createResponsesProvider({
  provider: 'azure-openai-responses',
  transport: 'azure-key',
  apiKeyEnv: 'AZURE_OPENAI_API_KEY'
});
export const openAICodexResponsesProvider = createResponsesProvider({
  provider: 'openai-codex',
  transport: 'codex'
});

function createResponsesProvider(config: ResponsesProviderConfig): StreamFn {
  return (model, inputMessages, inputOptions) => {
    const provider = config.provider;
    const stream = new AssistantEventStream();
    const apiKey = model.apiKey?.trim() || (config.apiKeyEnv ? process.env[config.apiKeyEnv]?.trim() : undefined);
    if (!apiKey) {
      const isAccountRoute = config.transport === 'account' || config.transport === 'codex';
      const accountLabel = provider === 'openai-codex' ? 'Codex' : 'ChatGPT';
      const missingKeyHint = config.apiKeyEnv ? ` or ${config.apiKeyEnv}` : '';
      const message = isAccountRoute
        ? `The selected ${accountLabel} account did not provide an access token.`
        : `Missing API key for provider '${provider}'. Set model.apiKey${missingKeyHint}.`;
      queueMicrotask(() => {
        stream.error(new ProviderError({ code: 'authentication', provider, message }));
      });
      return stream;
    }

    const { messages, options } = resolveModelTranscript(
      inputMessages,
      inputOptions,
      model.compat?.supportsMidConvoSystemMessages === true
    );
    const sanitizedMessages = sanitizeMessagesForProvider(messages, model);
    const body = buildRequestBody(provider, model, sanitizedMessages, options);

    void (async () => {
      try {
        const endpoint = resolveEndpoint(config, model);
        const headers: Record<string, string> = {
          Accept: 'text/event-stream',
          'Content-Type': 'application/json',
          ...model.compat?.extraHeaders
        };
        if (config.transport === 'azure-key') headers['api-key'] = apiKey;
        else headers.Authorization = `Bearer ${apiKey}`;
        if (config.transport === 'codex') {
          headers.originator = 'inkpi';
          headers['OpenAI-Beta'] = 'responses=experimental';
          headers['chatgpt-account-id'] = extractCodexAccountId(apiKey, provider);
          if (options?.providerSessionId) {
            headers['session-id'] = options.providerSessionId;
            headers['x-client-request-id'] = options.providerSessionId;
          }
        }
        const response = await getHttpClient().fetch(endpoint, {
          method: 'POST',
          headers,
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
              provider,
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
              provider,
              message: `${provider} Responses API returned no event stream.`
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
        const reasoningSummaryByIndex = new Map<number, string>();
        const reasoningSignatureItems = new Set<string>();

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
          const data = parseEventJson(dataText, provider);
          const type = typeof data.type === 'string' ? data.type : eventName;

          if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
            if (typeof data.delta === 'string' && data.delta) {
              sawText = true;
              sawOutput = true;
              stream.push({ type: 'text_delta', textDelta: data.delta, blockIndex: outputIndex(data.output_index) });
            }
            return;
          }
          if (type === 'response.reasoning_summary_text.delta') {
            if (typeof data.delta === 'string' && data.delta) {
              sawOutput = true;
              const blockIndex = outputIndex(data.output_index);
              if (blockIndex !== undefined) {
                reasoningSummaryByIndex.set(
                  blockIndex,
                  `${reasoningSummaryByIndex.get(blockIndex) ?? ''}${data.delta}`
                );
              }
              stream.push({ type: 'thinking_delta', thinkingDelta: data.delta, blockIndex });
            }
            return;
          }
          if (type === 'response.output_item.added' || type === 'response.output_item.done') {
            const item = asRecord(data.item);
            const blockIndex = outputIndex(data.output_index);
            if (item?.type === 'function_call') {
              const state = registerFunctionCall(provider, item, callsByItemId, stream, blockIndex);
              if (type === 'response.output_item.done') finalizeFunctionCall(state, item.arguments, stream);
            }
            if (type === 'response.output_item.done' && item?.type === 'reasoning') {
              emitReasoningItem(item, blockIndex, reasoningSummaryByIndex, reasoningSignatureItems, stream, () => {
                sawOutput = true;
              });
            }
            if (type === 'response.output_item.done' && item?.type === 'message' && !sawText) {
              emitFinalMessageText(
                item,
                stream,
                () => {
                  sawText = true;
                  sawOutput = true;
                },
                blockIndex
              );
            }
            return;
          }
          if (type === 'response.function_call_arguments.delta') {
            const itemId = typeof data.item_id === 'string' ? data.item_id : '';
            const state = callsByItemId.get(itemId);
            if (!state || typeof data.delta !== 'string') {
              throw malformed(provider, 'OpenAI Responses API returned function arguments without a call.');
            }
            state.argumentChunks.push(data.delta);
            if (data.delta) {
              sawOutput = true;
              stream.push({ type: 'tool_call_delta', toolCallId: state.callId, argsDelta: data.delta });
            }
            return;
          }
          if (type === 'response.function_call_arguments.done') {
            const itemId = typeof data.item_id === 'string' ? data.item_id : '';
            const state = callsByItemId.get(itemId);
            if (!state) throw malformed(provider, 'OpenAI Responses API returned an unknown function call.');
            finalizeFunctionCall(state, data.arguments, stream);
            sawOutput = true;
            return;
          }
          if (type === 'response.completed' || type === 'response.done') {
            const responseRecord = asRecord(data.response);
            if (responseRecord) {
              emitUsage(responseRecord.usage, stream);
              if (!sawText && Array.isArray(responseRecord.output)) {
                for (const [outputIndex, itemValue] of responseRecord.output.entries()) {
                  const item = asRecord(itemValue);
                  if (item?.type === 'message') {
                    emitFinalMessageText(
                      item,
                      stream,
                      () => {
                        sawText = true;
                        sawOutput = true;
                      },
                      outputIndex
                    );
                  } else if (item?.type === 'function_call') {
                    const state = registerFunctionCall(provider, item, callsByItemId, stream, outputIndex);
                    finalizeFunctionCall(state, item.arguments, stream);
                    sawOutput = true;
                  } else if (item?.type === 'reasoning') {
                    emitReasoningItem(
                      item,
                      outputIndex,
                      reasoningSummaryByIndex,
                      reasoningSignatureItems,
                      stream,
                      () => {
                        sawOutput = true;
                      }
                    );
                  }
                }
              } else if (Array.isArray(responseRecord.output)) {
                for (const [outputIndex, itemValue] of responseRecord.output.entries()) {
                  const item = asRecord(itemValue);
                  if (item?.type === 'reasoning') {
                    emitReasoningItem(
                      item,
                      outputIndex,
                      reasoningSummaryByIndex,
                      reasoningSignatureItems,
                      stream,
                      () => {
                        sawOutput = true;
                      }
                    );
                    continue;
                  }
                  if (item?.type !== 'function_call') continue;
                  const state = registerFunctionCall(provider, item, callsByItemId, stream, outputIndex);
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
            throw classifyProviderError(new Error(message), { provider });
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
            provider,
            sawDone
              ? `${provider} Responses API stream ended before completion.`
              : `${provider} Responses API stream ended unexpectedly.`
          );
        }
        if (!sawOutput) throw malformed(provider, `${provider} Responses API completed without assistant output.`);
        stream.end();
      } catch (error: unknown) {
        if (isAbortError(error)) stream.abort();
        else stream.error(classifyProviderError(error, { provider }));
      }
    })();

    return stream;
  };
}

function resolveEndpoint(config: ResponsesProviderConfig, model: ModelConfig): string {
  if (config.transport === 'account') return CHATGPT_PLAN_RESPONSES_ENDPOINT;
  if (config.transport === 'codex') {
    const url = validateBaseUrl(model.baseUrl?.trim() || CODEX_BASE_URL, config.provider, true);
    if (url.origin !== 'https://chatgpt.com') {
      throw new ProviderError({
        code: 'invalid_request',
        provider: config.provider,
        message: 'Codex OAuth tokens may only be sent to the official ChatGPT Codex endpoint.'
      });
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (path === '/backend-api') url.pathname = `${path}/codex/responses`;
    else if (path === '/backend-api/codex') url.pathname = `${path}/responses`;
    else if (path !== '/backend-api/codex/responses') {
      throw new ProviderError({
        code: 'invalid_request',
        provider: config.provider,
        message: 'Codex base URL must be the official ChatGPT backend API endpoint.'
      });
    }
    return url.toString();
  }

  const isAzure = config.transport === 'azure-key';
  const baseUrl = model.baseUrl?.trim() || (isAzure ? '' : OPENAI_RESPONSES_BASE_URL);
  if (!baseUrl) {
    throw new ProviderError({
      code: 'invalid_request',
      provider: config.provider,
      message: 'Azure OpenAI Responses requires the Azure resource base URL.'
    });
  }
  const url = validateBaseUrl(baseUrl, config.provider);
  let path = url.pathname.replace(/\/+$/, '');
  if (path.endsWith('/responses')) return url.toString();
  if (isAzure) {
    if (!path.endsWith('/openai/v1')) path = `${path}/openai/v1`;
    url.pathname = `${path}/responses`;
  } else {
    if (!path.endsWith('/v1')) path = `${path}/v1`;
    url.pathname = `${path}/responses`;
  }
  return url.toString();
}

function validateBaseUrl(value: string, provider: string, codex = false): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderError({ code: 'invalid_request', provider, message: 'Model provider base URL is invalid.' });
  }
  if (
    (url.protocol !== 'https:' && url.protocol !== 'http:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (codex && url.protocol !== 'https:')
  ) {
    throw new ProviderError({
      code: 'invalid_request',
      provider,
      message: 'Model provider base URL must use HTTP(S) without credentials, query, or fragment data.'
    });
  }
  return url;
}

function extractCodexAccountId(token: string, provider: string): string {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('Invalid access token');
    const claims: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const account = asRecord(asRecord(claims)?.[OPENAI_ACCOUNT_CLAIM]);
    const accountId = account?.chatgpt_account_id;
    if (
      typeof accountId !== 'string' ||
      !accountId.trim() ||
      accountId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(accountId)
    ) {
      throw new Error('Missing account identity claim');
    }
    return accountId;
  } catch {
    throw new ProviderError({
      code: 'authentication',
      provider,
      message: 'The Codex access token is missing its account identity claim.'
    });
  }
}

function buildRequestBody(
  provider: ResponsesProviderConfig['provider'],
  model: ModelConfig,
  messages: AgentMessage[],
  options?: StreamOptions
): Record<string, unknown> {
  const input: Record<string, unknown>[] = [];
  const instructions: string[] = [];
  if (options?.systemPrompt) {
    if (provider === 'openai-codex') instructions.push(options.systemPrompt);
    else input.push({ role: 'developer', content: options.systemPrompt });
  }
  for (const message of messages) {
    if (message.role === 'system') {
      if (message.content) {
        if (provider === 'openai-codex') instructions.push(message.content);
        else input.push({ role: 'developer', content: message.content });
      }
    } else if (message.role === 'user') {
      const content = typeof message.content === 'string' ? message.content : userContent(message.content);
      if (content) input.push({ role: 'user', content });
    } else if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type === 'text' && block.text) {
          input.push({ role: 'assistant', content: block.text });
        } else if (block.type === 'thinking' && block.providerSignature) {
          input.push({ type: 'reasoning', encrypted_content: block.providerSignature });
        } else if (block.type === 'toolCall') {
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.arguments)
          });
        }
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
  if (provider === 'openai-codex') {
    body.instructions = instructions.join('\n\n') || 'You are a helpful assistant.';
    body.include = ['reasoning.encrypted_content'];
    body.text = { verbosity: 'low' };
    body.tool_choice = 'auto';
    body.parallel_tool_calls = true;
    if (options?.providerSessionId) body.prompt_cache_key = options.providerSessionId;
  }
  const maxOutputTokens = options?.maxTokens ?? model.maxTokens;
  if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
    body.max_output_tokens = Math.floor(maxOutputTokens);
  }
  const temperature = options?.temperature ?? model.temperature;
  if (model.supportsThinking === true) {
    const requestedEffort = options?.reasoningEffort ?? model.reasoningEffort ?? 'medium';
    const effort = requestedEffort === 'max' ? 'xhigh' : requestedEffort;
    body.reasoning = effort === 'none' ? { effort } : { effort, summary: 'auto' };
  }
  if (
    provider !== 'openai-codex' &&
    model.supportsThinking !== true &&
    typeof temperature === 'number' &&
    Number.isFinite(temperature)
  ) {
    body.temperature = temperature;
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
  provider: string,
  item: Record<string, unknown>,
  callsByItemId: Map<string, FunctionCallState>,
  stream: AssistantEventStream,
  blockIndex?: number
): FunctionCallState {
  const callId = typeof item.call_id === 'string' ? item.call_id : '';
  const itemId = typeof item.id === 'string' ? item.id : callId;
  const name = typeof item.name === 'string' ? item.name : '';
  if (!callId || !itemId || !name)
    throw malformed(provider, 'OpenAI Responses API returned an incomplete function call.');
  let state = callsByItemId.get(itemId);
  if (!state) {
    state = {
      provider,
      itemId,
      callId,
      name,
      argumentChunks: [],
      ...(blockIndex !== undefined ? { blockIndex } : {}),
      finalized: false
    };
    callsByItemId.set(itemId, state);
    stream.push({
      type: 'tool_call_start',
      toolCallId: callId,
      toolName: name,
      ...(blockIndex !== undefined ? { blockIndex } : {})
    });
  } else if (state.callId !== callId || state.name !== name) {
    throw malformed(provider, 'OpenAI Responses API changed a function call identity mid-stream.');
  }
  if (typeof item.arguments === 'string' && state.argumentChunks.length === 0 && item.arguments) {
    state.argumentChunks.push(item.arguments);
    stream.push({ type: 'tool_call_delta', toolCallId: callId, argsDelta: item.arguments });
  }
  return state;
}

function finalizeFunctionCall(state: FunctionCallState, finalArguments: unknown, stream: AssistantEventStream): void {
  if (state.finalized) return;
  let argumentsText = state.argumentChunks.join('');
  if (typeof finalArguments === 'string' && argumentsText !== finalArguments) {
    if (!finalArguments.startsWith(argumentsText)) {
      throw malformed(state.provider, 'OpenAI Responses API function arguments did not match the streamed deltas.');
    }
    const missing = finalArguments.slice(argumentsText.length);
    if (missing) stream.push({ type: 'tool_call_delta', toolCallId: state.callId, argsDelta: missing });
    argumentsText = finalArguments;
  }
  let argumentsValue: Record<string, unknown>;
  try {
    const parsed: unknown = argumentsText ? JSON.parse(argumentsText) : {};
    if (!isRecord(parsed)) throw new Error('arguments must be an object');
    argumentsValue = parsed;
  } catch {
    throw malformed(state.provider, `OpenAI Responses API returned invalid arguments for '${state.name}'.`);
  }
  stream.push({
    type: 'tool_call_end',
    toolCall: { type: 'toolCall', id: state.callId, name: state.name, arguments: argumentsValue }
  });
  state.finalized = true;
}

function emitFinalMessageText(
  item: Record<string, unknown>,
  stream: AssistantEventStream,
  onOutput: () => void,
  blockIndex?: number
): void {
  if (!Array.isArray(item.content)) return;
  for (const blockValue of item.content) {
    const block = asRecord(blockValue);
    if (!block || (block.type !== 'output_text' && block.type !== 'refusal') || typeof block.text !== 'string')
      continue;
    if (!block.text) continue;
    onOutput();
    stream.push({ type: 'text_delta', textDelta: block.text, ...(blockIndex !== undefined ? { blockIndex } : {}) });
  }
}

function emitReasoningItem(
  item: Record<string, unknown>,
  blockIndex: number | undefined,
  summariesByIndex: Map<number, string>,
  signatureItems: Set<string>,
  stream: AssistantEventStream,
  onOutput: () => void
): void {
  if (blockIndex === undefined) return;
  const summaryParts: string[] = [];
  if (Array.isArray(item.summary)) {
    for (const value of item.summary) {
      const block = asRecord(value);
      if (!block || (block.type !== 'summary_text' && block.type !== 'output_text')) continue;
      if (typeof block.text === 'string') summaryParts.push(block.text);
    }
  }
  const summary = summaryParts.join('');
  const previous = summariesByIndex.get(blockIndex) ?? '';
  if (summary.length > previous.length && summary.startsWith(previous)) {
    const delta = summary.slice(previous.length);
    summariesByIndex.set(blockIndex, summary);
    stream.push({ type: 'thinking_delta', thinkingDelta: delta, blockIndex });
    onOutput();
  }

  const encryptedContent = typeof item.encrypted_content === 'string' ? item.encrypted_content : '';
  const itemId = typeof item.id === 'string' ? item.id : `reasoning-${blockIndex}`;
  if (encryptedContent && !signatureItems.has(itemId)) {
    if (!summariesByIndex.has(blockIndex)) stream.push({ type: 'thinking_delta', thinkingDelta: '', blockIndex });
    stream.push({ type: 'thinking_signature', blockIndex, providerSignature: encryptedContent });
    signatureItems.add(itemId);
    onOutput();
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

function parseEventJson(value: string, provider: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    const record = asRecord(parsed);
    if (!record) throw new Error('event is not an object');
    return record;
  } catch {
    throw malformed(provider, `${provider} Responses API returned a malformed stream event.`);
  }
}

function findEventBoundary(value: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/.exec(value);
  return match?.index === undefined ? undefined : { index: match.index, length: match[0].length };
}

function malformed(provider: string, message: string): ProviderError {
  return new ProviderError({ code: 'malformed_response', provider, message, retryable: false });
}

function outputIndex(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : undefined;
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
