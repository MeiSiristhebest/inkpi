import type { AgentMessage, AssistantMessageEvent, StandardLlmMessage } from '@inkpi/protocol';
import { ProviderNotImplementedError } from './errors.js';
import { AssistantEventStream } from './stream.js';
import type { EventStream, FauxScriptedResponse, ModelConfig, ProviderType, StreamOptions } from './types.js';

export function convertMessagesToStandard(messages: AgentMessage[], systemPrompt?: string): StandardLlmMessage[] {
  const result: StandardLlmMessage[] = [];
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.content });
    } else if (msg.role === 'user') {
      const text =
        typeof msg.content === 'string'
          ? msg.content
          : msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      result.push({ role: 'user', content: text });
    } else if (msg.role === 'assistant') {
      const texts: string[] = [];
      const toolCalls: NonNullable<StandardLlmMessage['toolCalls']> = [];
      for (const item of msg.content) {
        if (item.type === 'text') {
          texts.push(item.text);
        } else if (item.type === 'toolCall') {
          toolCalls.push({
            id: item.id,
            type: 'function',
            function: {
              name: item.name,
              arguments: JSON.stringify(item.arguments)
            }
          });
        }
      }
      result.push({
        role: 'assistant',
        content: texts.join('\n'),
        ...(toolCalls.length > 0 ? { toolCalls } : {})
      });
    } else if (msg.role === 'toolResult') {
      const text = msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      result.push({
        role: 'tool',
        toolCallId: msg.toolCallId,
        content: text
      });
    }
  }

  return result;
}

export interface OpenAiWireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

/**
 * Convert the internal camelCase message contract to the OpenAI wire contract.
 * Provider payloads must not expose StandardLlmMessage field names.
 */
export function convertMessagesToOpenAi(messages: AgentMessage[], systemPrompt?: string): OpenAiWireMessage[] {
  return convertMessagesToStandard(messages, systemPrompt).map((message) => {
    if (message.role === 'assistant') {
      return {
        role: message.role,
        content: message.content,
        ...(message.toolCalls ? { tool_calls: message.toolCalls } : {})
      };
    }
    if (message.role === 'tool') {
      return {
        role: message.role,
        content: message.content,
        tool_call_id: message.toolCallId
      };
    }
    return {
      role: message.role,
      content: message.content
    };
  });
}

export interface AnthropicWireContentBlock {
  type: 'text' | 'image' | 'tool_use' | 'tool_result';
  text?: string;
  source?: { type: 'base64'; media_type: string; data: string } | { type: 'url'; url: string };
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string | AnthropicWireContentBlock[];
  is_error?: boolean;
}

export interface AnthropicWireMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicWireContentBlock[];
}

export interface AnthropicMessageConversion {
  systemMessages: string[];
  messages: AnthropicWireMessage[];
}

function convertAnthropicUserContent(
  content: Extract<AgentMessage, { role: 'user' }>['content']
): string | AnthropicWireContentBlock[] {
  if (typeof content === 'string') return content;

  const blocks = content.map((item): AnthropicWireContentBlock => {
    if (item.type === 'text') {
      return { type: 'text', text: item.text };
    }
    if (item.image.startsWith('http://') || item.image.startsWith('https://')) {
      return {
        type: 'image',
        source: { type: 'url', url: item.image }
      };
    }
    if (!item.mimeType) {
      throw new Error('Anthropic base64 image content requires mimeType.');
    }
    return {
      type: 'image',
      source: { type: 'base64', media_type: item.mimeType, data: item.image }
    };
  });

  return blocks;
}

/**
 * Convert the internal content-block protocol to Anthropic Messages blocks.
 * System messages are returned separately because Anthropic does not accept a
 * system role in its messages array.
 */
export function convertMessagesToAnthropic(messages: AgentMessage[]): AnthropicMessageConversion {
  const systemMessages: string[] = [];
  const converted: AnthropicWireMessage[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];

    if (message.role === 'system') {
      if (message.content.trim()) systemMessages.push(message.content);
      continue;
    }

    if (message.role === 'user') {
      converted.push({
        role: 'user',
        content: convertAnthropicUserContent(message.content)
      });
      continue;
    }

    if (message.role === 'assistant') {
      const blocks: AnthropicWireContentBlock[] = [];
      for (const item of message.content) {
        if (item.type === 'text' && item.text.length > 0) {
          blocks.push({ type: 'text', text: item.text });
        } else if (item.type === 'thinking' && item.thinking.length > 0) {
          // This protocol does not retain Anthropic thinking signatures, so
          // replay unsigned thinking as text instead of sending invalid blocks.
          blocks.push({ type: 'text', text: item.thinking });
        } else if (item.type === 'toolCall') {
          blocks.push({
            type: 'tool_use',
            id: item.id,
            name: item.name,
            input: item.arguments
          });
        }
      }
      if (blocks.length > 0) {
        converted.push({ role: 'assistant', content: blocks });
      }
      continue;
    }

    if (message.role === 'toolResult') {
      const blocks: AnthropicWireContentBlock[] = [];
      let cursor = index;
      while (cursor < messages.length && messages[cursor]?.role === 'toolResult') {
        const toolResult = messages[cursor] as Extract<AgentMessage, { role: 'toolResult' }>;
        const text = toolResult.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('\n');
        blocks.push({
          type: 'tool_result',
          tool_use_id: toolResult.toolCallId,
          content: text || '(no tool output)',
          ...(toolResult.isError ? { is_error: true } : {})
        });
        cursor += 1;
      }
      converted.push({ role: 'user', content: blocks });
      index = cursor - 1;
    }
  }

  return { systemMessages, messages: converted };
}

export type ProviderHandler = (
  model: ModelConfig,
  messages: AgentMessage[],
  options?: StreamOptions
) => EventStream<AssistantMessageEvent>;

const providerRegistry = new Map<ProviderType, ProviderHandler>();

/**
 * Provider aliases do not necessarily match their credential environment
 * variable names. Keep this mapping explicit so custom providers must provide
 * credentials through ModelConfig instead of silently guessing.
 */
export const PROVIDER_API_KEY_ENV: Readonly<Record<string, string>> = {
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  openai: 'OPENAI_API_KEY',
  claude: 'ANTHROPIC_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY'
};

export function resolveProviderApiKeyEnv(provider: string): string | undefined {
  return PROVIDER_API_KEY_ENV[provider];
}

// ----------------------------------------------------------------------
// 1. Faux / Test Provider（仅作为显式测试夹具，不在生产注册表注册）
// ----------------------------------------------------------------------
export function createFauxProvider(script?: FauxScriptedResponse): ProviderHandler {
  return (model, messages, options) => fauxProviderWithScript(script ?? model.fauxScript, model, messages, options);
}

function fauxProviderWithScript(
  script: FauxScriptedResponse | null | undefined,
  _model: ModelConfig,
  _messages: AgentMessage[],
  options?: StreamOptions
): EventStream<AssistantMessageEvent> {
  const stream = new AssistantEventStream();

  queueMicrotask(() => {
    if (options?.signal?.aborted) {
      stream.abort();
      return;
    }

    if (!script) {
      stream.error('Faux provider requires an explicit scripted response on the model or provider instance.');
      return;
    }
    const thinkingText = script.thinking;

    if (thinkingText) {
      stream.push({ type: 'thinking_delta', thinkingDelta: thinkingText });
    }

    if (script.toolCalls && script.toolCalls.length > 0) {
      for (const tc of script.toolCalls) {
        stream.push({ type: 'tool_call_start', toolCallId: tc.id, toolName: tc.name });
        stream.push({ type: 'tool_call_delta', toolCallId: tc.id, argsDelta: JSON.stringify(tc.arguments) });
        stream.push({
          type: 'tool_call_end',
          toolCall: { type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.arguments }
        });
      }
    } else {
      if (script.text !== undefined) {
        stream.push({ type: 'text_delta', textDelta: script.text });
      }
    }

    const usage = script.usage || legacyUsage(script);
    if (usage) stream.push({ type: 'usage', usage });

    stream.end();
  });

  return stream;
}

export const fauxProvider: ProviderHandler = (model, messages, options) =>
  fauxProviderWithScript(model.fauxScript, model, messages, options);

function legacyUsage(script: FauxScriptedResponse): import('@inkpi/protocol').Usage | undefined {
  const hasLegacyUsage = [
    script.inputTokens,
    script.outputTokens,
    script.cacheReadTokens,
    script.cacheWriteTokens,
    script.reasoningTokens
  ].some((value) => value !== undefined);
  if (!hasLegacyUsage) return undefined;

  const inputTokens = script.inputTokens ?? 0;
  const outputTokens = script.outputTokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: script.cacheReadTokens,
    cacheWriteTokens: script.cacheWriteTokens,
    reasoningTokens: script.reasoningTokens,
    totalTokens: inputTokens + outputTokens
  };
}

export const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  groq: 'https://api.groq.com/openai/v1',
  siliconflow: 'https://api.siliconflow.cn/v1',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
  ollama: 'http://localhost:11434'
};

export function resolveProviderBaseUrl(provider: string, explicitUrl?: string): string {
  if (explicitUrl) return explicitUrl;
  const defaultUrl = DEFAULT_BASE_URLS[provider];
  if (!defaultUrl) {
    throw new Error(`No default base URL is registered for provider '${provider}'. Configure model.baseUrl.`);
  }
  return defaultUrl;
}

function parseJsonStreamEvent(payload: string, provider: string): any {
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(`Malformed ${provider} stream event: ${payload.slice(0, 160)}`, { cause: error });
  }
}

function consumeCompleteLines(buffer: string, chunk: string, onLine: (line: string) => void): string {
  const lines = (buffer + chunk).split('\n');
  const remainder = lines.pop() || '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) onLine(trimmed);
  }
  return remainder;
}

function consumeFinalLine(buffer: string, onLine: (line: string) => void): void {
  const trimmed = buffer.trim();
  if (trimmed) onLine(trimmed);
}

// ----------------------------------------------------------------------
// 2. OpenAI / OpenRouter / DeepSeek / Groq / SiliconFlow / Azure SSE Provider
// ----------------------------------------------------------------------
export const openAiCompatibleProvider: ProviderHandler = (model, messages, options) => {
  const stream = new AssistantEventStream();
  const baseUrl = resolveProviderBaseUrl(model.provider, model.baseUrl);
  const apiKeyEnv = resolveProviderApiKeyEnv(model.provider);
  const apiKey = model.apiKey || (apiKeyEnv ? process.env[apiKeyEnv] : undefined) || '';

  if (!apiKey) {
    queueMicrotask(() => {
      stream.error(
        apiKeyEnv
          ? `Missing API key for provider '${model.provider}'. Set model.apiKey or ${apiKeyEnv}.`
          : `Missing API key for provider '${model.provider}'. Set model.apiKey explicitly.`
      );
    });
    return stream;
  }

  const standardMessages = convertMessagesToOpenAi(messages, options?.systemPrompt);

  (async () => {
    try {
      const payload: Record<string, unknown> = {
        model: model.id,
        messages: standardMessages,
        stream: true,
        temperature: options?.temperature ?? model.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? model.maxTokens,
        presence_penalty: model.presencePenalty,
        frequency_penalty: model.frequencyPenalty,
        stream_options: { include_usage: true }
      };

      if (options?.tools && options.tools.length > 0) {
        payload.tools = options.tools.map((t) => ({
          type: 'function',
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters
          }
        }));
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(payload),
        signal: options?.signal
      });

      if (!response.ok) {
        stream.error(`${model.provider} API Error: ${response.status} ${response.statusText}`);
        return;
      }

      if (!response.body) {
        stream.error(`No response body from ${model.provider} API`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let sawDone = false;
      let sawChoice = false;
      let sawOutput = false;
      let sawFinishReason = false;
      let sawUsage = false;
      const toolCallIdsByIndex = new Map<number, string>();
      const toolCallsById = new Map<string, { name: string; args: string }>();
      let lastToolCallId: string | undefined;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = consumeCompleteLines(buffer, decoder.decode(value, { stream: true }), (trimmed) => {
          if (!trimmed.startsWith('data:')) return;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') {
            sawDone = true;
            return;
          }

          {
            const data = parseJsonStreamEvent(dataStr, model.provider);
            if (data.usage) {
              sawUsage = true;
              stream.push({
                type: 'usage',
                usage: {
                  inputTokens: data.usage.prompt_tokens || 0,
                  outputTokens: data.usage.completion_tokens || 0,
                  totalTokens: data.usage.total_tokens || 0,
                  cacheReadTokens: data.usage.prompt_tokens_details?.cached_tokens || 0
                }
              });
            }

            const delta = data.choices?.[0]?.delta;
            if (data.choices?.length) sawChoice = true;
            if (data.choices?.[0]?.finish_reason) sawFinishReason = true;
            if (!delta) return;

            if (delta.reasoning_content) {
              sawOutput = true;
              stream.push({ type: 'thinking_delta', thinkingDelta: delta.reasoning_content });
            }
            if (delta.content) {
              sawOutput = true;
              stream.push({ type: 'text_delta', textDelta: delta.content });
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  const index = typeof tc.index === 'number' ? tc.index : undefined;
                  if (index !== undefined) toolCallIdsByIndex.set(index, tc.id);
                  lastToolCallId = tc.id;
                  if (!toolCallsById.has(tc.id)) toolCallsById.set(tc.id, { name: '', args: '' });
                  stream.push({ type: 'tool_call_start', toolCallId: tc.id, toolName: tc.function?.name || '' });
                }
                const toolCallId =
                  tc.id ||
                  (typeof tc.index === 'number' ? toolCallIdsByIndex.get(tc.index) : undefined) ||
                  lastToolCallId;
                if (toolCallId && !toolCallsById.has(toolCallId)) {
                  toolCallsById.set(toolCallId, { name: '', args: '' });
                }
                if (toolCallId && tc.function?.name) {
                  toolCallsById.get(toolCallId)!.name += tc.function.name;
                }
                if (toolCallId && tc.function?.arguments) {
                  toolCallsById.get(toolCallId)!.args += tc.function.arguments;
                }
                if (tc.function?.arguments) {
                  if (!toolCallId) {
                    throw new Error(`${model.provider} stream contained tool arguments without a tool call id`);
                  }
                  sawOutput = true;
                  stream.push({ type: 'tool_call_delta', toolCallId, argsDelta: tc.function.arguments });
                }
              }
            }
          }
        });
      }
      buffer += decoder.decode();
      consumeFinalLine(buffer, (trimmed) => {
        if (!trimmed.startsWith('data:')) return;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          sawDone = true;
          return;
        }
        const data = parseJsonStreamEvent(dataStr, model.provider);
        if (data.usage) {
          sawUsage = true;
          stream.push({
            type: 'usage',
            usage: {
              inputTokens: data.usage.prompt_tokens || 0,
              outputTokens: data.usage.completion_tokens || 0,
              totalTokens: data.usage.total_tokens || 0,
              cacheReadTokens: data.usage.prompt_tokens_details?.cached_tokens || 0
            }
          });
        }
        const delta = data.choices?.[0]?.delta;
        if (data.choices?.length) sawChoice = true;
        if (data.choices?.[0]?.finish_reason) sawFinishReason = true;
        if (!delta) return;
        if (delta.reasoning_content) {
          sawOutput = true;
          stream.push({ type: 'thinking_delta', thinkingDelta: delta.reasoning_content });
        }
        if (delta.content) {
          sawOutput = true;
          stream.push({ type: 'text_delta', textDelta: delta.content });
        }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            if (tc.id) {
              const index = typeof tc.index === 'number' ? tc.index : undefined;
              if (index !== undefined) toolCallIdsByIndex.set(index, tc.id);
              lastToolCallId = tc.id;
              stream.push({ type: 'tool_call_start', toolCallId: tc.id, toolName: tc.function?.name || '' });
            }
            if (tc.function?.arguments) {
              const toolCallId =
                tc.id ||
                (typeof tc.index === 'number' ? toolCallIdsByIndex.get(tc.index) : undefined) ||
                lastToolCallId;
              if (!toolCallId) {
                throw new Error(`${model.provider} stream contained tool arguments without a tool call id`);
              }
              sawOutput = true;
              stream.push({ type: 'tool_call_delta', toolCallId, argsDelta: tc.function.arguments });
            }
          }
        }
      });
      if (sawDone) {
        for (const [toolCallId, toolCall] of toolCallsById) {
          if (!toolCall.name) {
            stream.error(`Tool call '${toolCallId}' is missing a function name.`);
            return;
          }
          let argumentsValue: Record<string, unknown>;
          try {
            argumentsValue = toolCall.args ? JSON.parse(toolCall.args) : {};
          } catch {
            stream.error(`Tool call '${toolCallId}' has malformed JSON arguments.`);
            return;
          }
          stream.push({
            type: 'tool_call_end',
            toolCall: {
              type: 'toolCall',
              id: toolCallId,
              name: toolCall.name,
              arguments: argumentsValue
            }
          });
        }
      }
      if (!sawDone) {
        stream.error(`${model.provider} stream ended before [DONE].`);
        return;
      }
      if (!sawChoice && !sawUsage) {
        stream.error(`${model.provider} stream ended without choices or usage.`);
        return;
      }
      if (sawChoice && !sawOutput && !sawFinishReason) {
        stream.error(`${model.provider} stream ended without assistant output.`);
        return;
      }
      stream.end();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        stream.abort();
      } else {
        stream.error(err.message || `${model.provider} network error`);
      }
    }
  })();

  return stream;
};

// ----------------------------------------------------------------------
// 3. Anthropic Messages API Provider
// ----------------------------------------------------------------------
export const anthropicProvider: ProviderHandler = (model, messages, options) => {
  const stream = new AssistantEventStream();
  const baseUrl = model.baseUrl || 'https://api.anthropic.com/v1';
  const apiKey = model.apiKey || process.env.ANTHROPIC_API_KEY || '';

  if (!apiKey) {
    queueMicrotask(() => {
      stream.error('Missing API key for Anthropic provider. Please set ANTHROPIC_API_KEY.');
    });
    return stream;
  }

  const anthropicConversion = convertMessagesToAnthropic(messages);
  const anthropicMessages = anthropicConversion.messages;

  const bodyPayload: Record<string, unknown> = {
    model: model.id,
    messages: anthropicMessages,
    max_tokens: options?.maxTokens ?? model.maxTokens ?? 4096,
    temperature: options?.temperature ?? model.temperature ?? 0.7,
    stream: true
  };

  const systemMessages = [
    ...anthropicConversion.systemMessages,
    ...(options?.systemPrompt ? [options.systemPrompt] : [])
  ];
  if (systemMessages.length > 0) {
    bodyPayload.system = [
      {
        type: 'text',
        text: systemMessages.join('\n\n'),
        ...(options?.cacheControl ? { cache_control: { type: 'ephemeral' } } : {})
      }
    ];
  }

  if (model.supportsThinking || (options?.thinkingBudget && options.thinkingBudget > 0)) {
    bodyPayload.thinking = {
      type: 'enabled',
      budget_tokens: options?.thinkingBudget ?? model.thinkingBudget ?? 2048
    };
  }

  if (options?.tools && options.tools.length > 0) {
    bodyPayload.tools = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters
    }));
  }

  (async () => {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      };
      if (options?.cacheControl || model.supportsPromptCache) {
        headers['anthropic-beta'] = 'prompt-caching-2024-07-25';
      }

      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyPayload),
        signal: options?.signal
      });

      if (!response.ok) {
        stream.error(`Anthropic API Error: ${response.status} ${response.statusText}`);
        return;
      }

      if (!response.body) {
        stream.error('No response body from Anthropic API');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;
      let sawMessageStop = false;
      const openToolCalls = new Map<
        number,
        {
          id: string;
          name: string;
          args: string;
        }
      >();

      const emitUsage = () => {
        if (inputTokens === 0 && outputTokens === 0 && cacheReadTokens === 0 && cacheWriteTokens === 0) return;
        stream.push({
          type: 'usage',
          usage: {
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            totalTokens: inputTokens + outputTokens
          }
        });
      };

      const handleEvent = (dataStr: string) => {
        if (dataStr === '[DONE]') return;
        const data = parseJsonStreamEvent(dataStr, 'Anthropic');
        if (data.type === 'message_start' && data.message?.usage) {
          inputTokens = data.message.usage.input_tokens || 0;
          cacheReadTokens = data.message.usage.cache_read_input_tokens || 0;
          cacheWriteTokens = data.message.usage.cache_creation_input_tokens || 0;
          emitUsage();
        } else if (data.type === 'content_block_delta') {
          if (data.delta?.type === 'text_delta') {
            stream.push({ type: 'text_delta', textDelta: data.delta.text });
          } else if (data.delta?.type === 'thinking_delta') {
            stream.push({ type: 'thinking_delta', thinkingDelta: data.delta.thinking });
          } else if (data.delta?.type === 'input_json_delta') {
            const toolCall = openToolCalls.get(data.index);
            if (!toolCall) {
              throw new Error('Anthropic tool input delta received before content_block_start.');
            }
            const partialJson = data.delta.partial_json || '';
            toolCall.args += partialJson;
            stream.push({
              type: 'tool_call_delta',
              toolCallId: toolCall.id,
              argsDelta: partialJson
            });
          }
        } else if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
          const block = data.content_block;
          if (typeof data.index !== 'number' || !block.id || !block.name) {
            throw new Error('Anthropic tool_use block is missing index, id, or name.');
          }
          if (openToolCalls.has(data.index)) {
            throw new Error(`Duplicate Anthropic tool_use block at index ${data.index}.`);
          }
          const initialInput = block.input && typeof block.input === 'object' ? JSON.stringify(block.input) : '';
          openToolCalls.set(data.index, {
            id: block.id,
            name: block.name,
            args: initialInput === '{}' ? '' : initialInput
          });
          stream.push({ type: 'tool_call_start', toolCallId: block.id, toolName: block.name });
          if (initialInput && initialInput !== '{}') {
            stream.push({ type: 'tool_call_delta', toolCallId: block.id, argsDelta: initialInput });
          }
        } else if (data.type === 'content_block_stop' && typeof data.index === 'number') {
          const toolCall = openToolCalls.get(data.index);
          if (toolCall) {
            let argumentsValue: Record<string, unknown>;
            try {
              argumentsValue = toolCall.args ? JSON.parse(toolCall.args) : {};
            } catch {
              // Leave validation of incomplete JSON to AssistantEventStream.collect().
              openToolCalls.delete(data.index);
              return;
            }
            stream.push({
              type: 'tool_call_end',
              toolCall: {
                type: 'toolCall',
                id: toolCall.id,
                name: toolCall.name,
                arguments: argumentsValue
              }
            });
            openToolCalls.delete(data.index);
          }
        } else if (data.type === 'message_delta' && data.usage) {
          outputTokens = data.usage.output_tokens || outputTokens;
          emitUsage();
        } else if (data.type === 'message_stop') {
          sawMessageStop = true;
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = consumeCompleteLines(buffer, decoder.decode(value, { stream: true }), (trimmed) => {
          if (!trimmed.startsWith('data:')) return;
          handleEvent(trimmed.slice(5).trim());
        });
      }
      buffer += decoder.decode();
      consumeFinalLine(buffer, (trimmed) => {
        if (!trimmed.startsWith('data:')) return;
        handleEvent(trimmed.slice(5).trim());
      });
      if (openToolCalls.size > 0) {
        stream.error('Anthropic stream ended with an open tool_use block.');
        return;
      }
      if (!sawMessageStop) {
        stream.error('Anthropic stream ended before message_stop.');
        return;
      }
      stream.end();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        stream.abort();
      } else {
        stream.error(err.message || 'Anthropic network error');
      }
    }
  })();

  return stream;
};

// ----------------------------------------------------------------------
// 4. Google Generative AI Provider (Gemini SSE)
// ----------------------------------------------------------------------
export const geminiProvider: ProviderHandler = (model, messages, options) => {
  const stream = new AssistantEventStream();
  const apiKey = model.apiKey || process.env.GEMINI_API_KEY || '';

  if (!apiKey) {
    queueMicrotask(() => {
      stream.error('Missing API key for Gemini. Please set GEMINI_API_KEY.');
    });
    return stream;
  }

  const baseUrl = model.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const endpoint = `${baseUrl}/models/${model.id}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
  }));

  (async () => {
    try {
      const geminiBody: Record<string, unknown> = {
        contents,
        generationConfig: {
          temperature: options?.temperature ?? model.temperature ?? 0.7,
          maxOutputTokens: options?.maxTokens ?? model.maxTokens
        }
      };

      if (options?.systemPrompt) {
        geminiBody.systemInstruction = {
          parts: [{ text: options.systemPrompt }]
        };
      }

      if (options?.tools && options.tools.length > 0) {
        geminiBody.tools = [
          {
            functionDeclarations: options.tools.map((t) => ({
              name: t.name,
              description: t.description,
              parameters: t.parameters
            }))
          }
        ];
      }

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(geminiBody),
        signal: options?.signal
      });

      if (!response.ok) {
        stream.error(`Gemini API Error: ${response.status} ${response.statusText}`);
        return;
      }

      if (!response.body) {
        stream.error('No response body from Gemini API');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let sawCandidate = false;
      let sawFinishReason = false;

      const emitGeminiParts = (parts: any[]) => {
        for (const part of parts) {
          if (!part?.text) continue;
          if (part.thought === true) {
            stream.push({ type: 'thinking_delta', thinkingDelta: part.text });
          } else {
            stream.push({ type: 'text_delta', textDelta: part.text });
          }
        }
      };

      const emitGeminiUsage = (usageMetadata: any) => {
        if (!usageMetadata) return;
        stream.push({
          type: 'usage',
          usage: {
            inputTokens: usageMetadata.promptTokenCount || 0,
            outputTokens: usageMetadata.candidatesTokenCount || 0,
            totalTokens: usageMetadata.totalTokenCount || 0,
            cacheReadTokens: usageMetadata.cachedContentTokenCount || 0
          }
        });
      };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = consumeCompleteLines(buffer, decoder.decode(value, { stream: true }), (trimmed) => {
          if (!trimmed.startsWith('data:')) return;
          const dataStr = trimmed.slice(5).trim();

          {
            const data = parseJsonStreamEvent(dataStr, 'Gemini');
            const candidate = data.candidates?.[0];
            if (candidate) {
              sawCandidate = true;
              if (candidate.finishReason) sawFinishReason = true;
            }
            if (candidate?.content?.parts) {
              emitGeminiParts(candidate.content.parts);
            }
            emitGeminiUsage(data.usageMetadata);
          }
        });
      }
      buffer += decoder.decode();
      consumeFinalLine(buffer, (trimmed) => {
        if (!trimmed.startsWith('data:')) return;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') return;
        const data = parseJsonStreamEvent(dataStr, 'Gemini');
        const candidate = data.candidates?.[0];
        if (candidate) {
          sawCandidate = true;
          if (candidate.finishReason) sawFinishReason = true;
        }
        emitGeminiParts(candidate?.content?.parts || []);
        emitGeminiUsage(data.usageMetadata);
      });
      if (!sawCandidate) {
        stream.error('Gemini stream ended without a candidate.');
        return;
      }
      if (!sawFinishReason) {
        stream.error('Gemini stream ended without a finishReason.');
        return;
      }
      stream.end();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        stream.abort();
      } else {
        stream.error(err.message || 'Gemini network error');
      }
    }
  })();

  return stream;
};

// ----------------------------------------------------------------------
// 5. Ollama Provider for Local Offline inference
// ----------------------------------------------------------------------
export const ollamaProvider: ProviderHandler = (model, messages, options) => {
  const stream = new AssistantEventStream();
  const baseUrl = model.baseUrl || 'http://localhost:11434';
  const standardMessages = convertMessagesToStandard(messages, options?.systemPrompt);

  (async () => {
    try {
      const response = await fetch(`${baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: model.id,
          messages: standardMessages,
          stream: true,
          options: {
            temperature: options?.temperature ?? model.temperature ?? 0.7,
            num_predict: options?.maxTokens ?? model.maxTokens
          }
        }),
        signal: options?.signal
      });

      if (!response.ok) {
        stream.error(`Ollama Error: ${response.status} ${response.statusText}`);
        return;
      }

      if (!response.body) {
        stream.error('No response body from Ollama');
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let sawDone = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer = consumeCompleteLines(buffer, decoder.decode(value, { stream: true }), (trimmed) => {
          {
            const data = parseJsonStreamEvent(trimmed, 'Ollama');
            if (data.message?.content) {
              stream.push({ type: 'text_delta', textDelta: data.message.content });
            }
            if (data.done === true) {
              sawDone = true;
              stream.push({
                type: 'usage',
                usage: {
                  inputTokens: data.prompt_eval_count || 0,
                  outputTokens: data.eval_count || 0,
                  totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
                }
              });
            }
          }
        });
      }
      buffer += decoder.decode();
      consumeFinalLine(buffer, (trimmed) => {
        const data = parseJsonStreamEvent(trimmed, 'Ollama');
        if (data.message?.content) stream.push({ type: 'text_delta', textDelta: data.message.content });
        if (data.done === true) {
          sawDone = true;
          stream.push({
            type: 'usage',
            usage: {
              inputTokens: data.prompt_eval_count || 0,
              outputTokens: data.eval_count || 0,
              totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
            }
          });
        }
      });
      if (!sawDone) {
        stream.error('Ollama stream ended before done: true.');
        return;
      }
      stream.end();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        stream.abort();
      } else {
        stream.error(`Ollama connection error: ${err.message || `Ensure Ollama is running at ${baseUrl}`}`);
      }
    }
  })();

  return stream;
};

// ----------------------------------------------------------------------
// Provider Registry
// ----------------------------------------------------------------------
providerRegistry.set('deepseek', openAiCompatibleProvider);
providerRegistry.set('openai', openAiCompatibleProvider);
providerRegistry.set('claude', anthropicProvider);
providerRegistry.set('gemini', geminiProvider);
providerRegistry.set('ollama', ollamaProvider);
providerRegistry.set('groq', openAiCompatibleProvider);
providerRegistry.set('mistral', openAiCompatibleProvider);
providerRegistry.set('xai', openAiCompatibleProvider);
providerRegistry.set('openrouter', openAiCompatibleProvider);
providerRegistry.set('siliconflow', openAiCompatibleProvider);
providerRegistry.set('qwen', openAiCompatibleProvider);
// 未实现的 provider 不静默映射到其它传输层，而是显式失败，
// 避免请求被悄悄发往错误的端点（如 bedrock 错误转发到 Anthropic 公开 API）。
function unsupportedProvider(name: string): ProviderHandler {
  return () => {
    throw new ProviderNotImplementedError(name);
  };
}

providerRegistry.set('azure', unsupportedProvider('azure'));
providerRegistry.set('bedrock', unsupportedProvider('bedrock'));

export function deepSeekProvider(
  model: ModelConfig,
  messages: AgentMessage[],
  options?: StreamOptions
): EventStream<AssistantMessageEvent> {
  return openAiCompatibleProvider(model, messages, options);
}

export function mockProvider(
  model: ModelConfig,
  messages: AgentMessage[],
  options?: StreamOptions
): EventStream<AssistantMessageEvent> {
  return fauxProvider(model, messages, options);
}

export function registerProvider(type: ProviderType, handler: ProviderHandler): void {
  providerRegistry.set(type, handler);
}

export function getProvider(type: ProviderType): ProviderHandler {
  const handler = providerRegistry.get(type);
  if (!handler) {
    return (model, _messages, _options) => {
      const stream = new AssistantEventStream();
      queueMicrotask(() => {
        stream.error(`Provider '${type}' is not registered. Use registerProvider('${type}', handler) to register.`);
      });
      return stream;
    };
  }
  return handler;
}

export function streamAi(
  model: ModelConfig,
  messages: AgentMessage[],
  options?: StreamOptions
): EventStream<AssistantMessageEvent> {
  const handler = getProvider(model.provider);
  return handler(model, messages, options);
}
