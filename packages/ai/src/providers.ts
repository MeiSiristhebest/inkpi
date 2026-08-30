import type { AgentMessage, AssistantMessageEvent, StandardLlmMessage } from '@inkpi/protocol';
import { AssistantEventStream } from './stream.js';
import type { ModelConfig, StreamOptions, EventStream, ProviderType } from './types.js';

export function convertMessagesToStandard(messages: AgentMessage[], systemPrompt?: string): StandardLlmMessage[] {
  const result: StandardLlmMessage[] = [];
  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.map((c) => (c.type === 'text' ? c.text : '')).join('');
      result.push({ role: 'user', content: text });
    } else if (msg.role === 'assistant') {
      const texts: string[] = [];
      for (const item of msg.content) {
        if (item.type === 'text') {
          texts.push(item.text);
        }
      }
      result.push({ role: 'assistant', content: texts.join('\n') });
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

export type ProviderHandler = (
  model: ModelConfig,
  messages: AgentMessage[],
  options?: StreamOptions
) => EventStream<AssistantMessageEvent>;

const providerRegistry = new Map<ProviderType, ProviderHandler>();

// ----------------------------------------------------------------------
// 1. Faux / Test Provider (仅作为显式测试夹具，1:1 对标 repos/pi packages/ai/src/providers/faux.ts)
// ----------------------------------------------------------------------
export interface FauxScriptedResponse {
  thinking?: string;
  text?: string;
  toolCalls?: Array<{ id: string; name: string; arguments: Record<string, unknown> }>;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

let activeFauxScript: FauxScriptedResponse | null = null;

export function setFauxScript(script: FauxScriptedResponse | null): void {
  activeFauxScript = script;
}

export const fauxProvider: ProviderHandler = (model, messages, options) => {
  const stream = new AssistantEventStream();

  queueMicrotask(() => {
    if (options?.signal?.aborted) {
      stream.abort();
      return;
    }

    const script = activeFauxScript;
    const lastMsg = messages[messages.length - 1];
    let userPrompt = '';
    if (lastMsg && lastMsg.role === 'user') {
      userPrompt = typeof lastMsg.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg.content);
    }

    const defaultThinking = (model.supportsThinking || (options?.thinkingBudget && options.thinkingBudget > 0))
      ? `💡 [深度思考推演]\n1. 意图解析: "${userPrompt.slice(0, 30)}"\n2. 设定一致性检查: 角色阵营与战力基线稳定\n3. 情绪节奏规划: 营造沉浸式氛围与开篇悬念\n4. 门禁审计预检: 逻辑无矛盾，开始流式输出正文。`
      : undefined;

    const thinkingText = script?.thinking ?? defaultThinking;

    if (thinkingText) {
      stream.push({ type: 'thinking_delta', thinkingDelta: thinkingText + '\n\n' });
    }

    if (script?.toolCalls && script.toolCalls.length > 0) {
      for (const tc of script.toolCalls) {
        stream.push({ type: 'tool_call_start', toolCallId: tc.id, toolName: tc.name });
        stream.push({ type: 'tool_call_delta', toolCallId: tc.id, argsDelta: JSON.stringify(tc.arguments) });
        stream.push({
          type: 'tool_call_end',
          toolCall: { type: 'toolCall', id: tc.id, name: tc.name, arguments: tc.arguments }
        });
      }
    } else {
      let textOutput = script?.text;
      if (!textOutput) {
        if (userPrompt) {
          textOutput = `【InkPi 创作试写正文】\n　　九霄大陆，长夜将尽。寒风如刀，卷起漫天碎雪呼啸掠过断崖。\n　　少年按紧了怀中泛着幽微蓝光的神秘古玉，目光沉冷如渊。三年隐忍与蛰伏，只为今朝破关一战。\n　　“既然天道不公，那我便以手中之剑，亲自劈开这无尽长夜！”\n　　随着一声低沉的剑鸣，远方沉寂已久的古老禁地骤然爆发出万丈神芒，属于新一代强者的传奇序曲在此刻轰然奏响。`;
        } else {
          textOutput = 'Generated response.';
        }
      }

      // 拟真流式逐字输出
      const chunkSize = 20;
      for (let i = 0; i < textOutput.length; i += chunkSize) {
        stream.push({ type: 'text_delta', textDelta: textOutput.slice(i, i + chunkSize) });
      }
    }


    const hasCache = Boolean(options?.cacheControl || model.supportsPromptCache);
    const inputTokens = script?.inputTokens ?? (hasCache ? 20 : 50);
    const outputTokens = script?.outputTokens ?? 30;
    const cacheReadTokens = script?.cacheReadTokens ?? (hasCache ? 30 : 0);
    const cacheWriteTokens = script?.cacheWriteTokens ?? (hasCache ? 10 : 0);
    const reasoningTokens = script?.reasoningTokens ?? (thinkingText ? 20 : 0);

    stream.push({
      type: 'usage',
      usage: {
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
        reasoningTokens
      }
    });

    stream.end();
  });

  return stream;
};

// ----------------------------------------------------------------------
// 2. OpenAI / OpenRouter / DeepSeek / Groq / Azure SSE Provider
// ----------------------------------------------------------------------
export const openAiCompatibleProvider: ProviderHandler = (model, messages, options) => {
  const stream = new AssistantEventStream();
  const baseUrl = model.baseUrl || (model.provider === 'deepseek' ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1');
  const apiKey = model.apiKey || process.env[`${model.provider.toUpperCase()}_API_KEY`] || process.env.OPENAI_API_KEY || '';

  if (!apiKey) {
    if (model.provider === 'custom') {
      return fauxProvider(model, messages, options);
    }
    queueMicrotask(() => {
      stream.error(`Missing API key for provider '${model.provider}'. Set apiKey or environment variable.`);
    });
    return stream;
  }

  const standardMessages = convertMessagesToStandard(messages, options?.systemPrompt);

  (async () => {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model.id,
          messages: standardMessages,
          stream: true,
          temperature: options?.temperature ?? model.temperature ?? 0.7,
          max_tokens: options?.maxTokens ?? model.maxTokens,
          presence_penalty: model.presencePenalty,
          frequency_penalty: model.frequencyPenalty,
          stream_options: { include_usage: true }
        }),
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();
          if (dataStr === '[DONE]') continue;

          try {
            const data = JSON.parse(dataStr);
            if (data.usage) {
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
            if (!delta) continue;

            if (delta.reasoning_content) {
              stream.push({ type: 'thinking_delta', thinkingDelta: delta.reasoning_content });
            }
            if (delta.content) {
              stream.push({ type: 'text_delta', textDelta: delta.content });
            }
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (tc.id) {
                  stream.push({ type: 'tool_call_start', toolCallId: tc.id, toolName: tc.function?.name || '' });
                }
                if (tc.function?.arguments) {
                  stream.push({ type: 'tool_call_delta', toolCallId: tc.id || '', argsDelta: tc.function.arguments });
                }
              }
            }
          } catch {
            // Buffer chunk
          }
        }
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
// 3. Anthropic Messages API Provider (1:1 对标 repos/pi anthropic-messages.ts)
// ----------------------------------------------------------------------
export const anthropicProvider: ProviderHandler = (model, messages, options) => {
  const stream = new AssistantEventStream();
  const baseUrl = model.baseUrl || 'https://api.anthropic.com/v1';
  const apiKey = model.apiKey || process.env.ANTHROPIC_API_KEY || '';

  if (!apiKey) {
    if (model.provider === 'custom') {
      return fauxProvider(model, messages, options);
    }
    queueMicrotask(() => {
      stream.error(`Missing API key for Anthropic provider. Please set ANTHROPIC_API_KEY.`);
    });
    return stream;
  }

  const anthropicMessages = messages.map((m) => {
    const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: text };
  });

  const bodyPayload: Record<string, unknown> = {
    model: model.id,
    messages: anthropicMessages,
    max_tokens: options?.maxTokens ?? model.maxTokens ?? 4096,
    temperature: options?.temperature ?? model.temperature ?? 0.7,
    stream: true
  };

  if (options?.systemPrompt) {
    bodyPayload.system = [
      {
        type: 'text',
        text: options.systemPrompt,
        ...(options.cacheControl ? { cache_control: { type: 'ephemeral' } } : {})
      }
    ];
  }

  if (model.supportsThinking || (options?.thinkingBudget && options.thinkingBudget > 0)) {
    bodyPayload.thinking = {
      type: 'enabled',
      budget_tokens: options?.thinkingBudget ?? model.thinkingBudget ?? 2048
    };
  }

  (async () => {
    try {
      const response = await fetch(`${baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();

          try {
            const data = JSON.parse(dataStr);
            if (data.type === 'content_block_delta') {
              if (data.delta?.type === 'text_delta') {
                stream.push({ type: 'text_delta', textDelta: data.delta.text });
              } else if (data.delta?.type === 'thinking_delta') {
                stream.push({ type: 'thinking_delta', thinkingDelta: data.delta.thinking });
              }
            } else if (data.type === 'message_delta' && data.usage) {
              stream.push({
                type: 'usage',
                usage: {
                  inputTokens: data.usage.input_tokens || 0,
                  outputTokens: data.usage.output_tokens || 0,
                  cacheReadTokens: data.usage.cache_read_input_tokens || 0,
                  cacheWriteTokens: data.usage.cache_creation_input_tokens || 0,
                  totalTokens: (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0)
                }
              });
            }
          } catch {}
        }
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
    if (model.provider === 'custom') {
      return fauxProvider(model, messages, options);
    }
    queueMicrotask(() => {
      stream.error('Missing API key for Gemini. Please set GEMINI_API_KEY.');
    });
    return stream;
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model.id}:streamGenerateContent?alt=sse&key=${apiKey}`;

  const contents = messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }]
  }));

  (async () => {
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents,
          generationConfig: {
            temperature: options?.temperature ?? model.temperature ?? 0.7,
            maxOutputTokens: options?.maxTokens ?? model.maxTokens
          }
        }),
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const dataStr = trimmed.slice(5).trim();

          try {
            const data = JSON.parse(dataStr);
            const candidate = data.candidates?.[0];
            if (candidate?.content?.parts) {
              for (const part of candidate.content.parts) {
                if (part.thought) {
                  stream.push({ type: 'thinking_delta', thinkingDelta: part.thought });
                }
                if (part.text) {
                  stream.push({ type: 'text_delta', textDelta: part.text });
                }
              }
            }
            if (data.usageMetadata) {
              stream.push({
                type: 'usage',
                usage: {
                  inputTokens: data.usageMetadata.promptTokenCount || 0,
                  outputTokens: data.usageMetadata.candidatesTokenCount || 0,
                  totalTokens: data.usageMetadata.totalTokenCount || 0,
                  cacheReadTokens: data.usageMetadata.cachedContentTokenCount || 0
                }
              });
            }
          } catch {}
        }
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const data = JSON.parse(trimmed);
            if (data.message?.content) {
              stream.push({ type: 'text_delta', textDelta: data.message.content });
            }
            if (data.done) {
              stream.push({
                type: 'usage',
                usage: {
                  inputTokens: data.prompt_eval_count || 0,
                  outputTokens: data.eval_count || 0,
                  totalTokens: (data.prompt_eval_count || 0) + (data.eval_count || 0)
                }
              });
            }
          } catch {}
        }
      }
      stream.end();
    } catch (err: any) {
      if (err.name === 'AbortError') {
        stream.abort();
      } else {
        stream.error(`Ollama connection error: ${err.message || 'Ensure Ollama is running at ' + baseUrl}`);
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
providerRegistry.set('azure', openAiCompatibleProvider);
providerRegistry.set('bedrock', anthropicProvider);
providerRegistry.set('custom', fauxProvider);

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
