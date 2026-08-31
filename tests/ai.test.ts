import { describe, it, expect, vi } from 'vitest';
import {
  AssistantEventStream,
  convertMessagesToStandard,
  streamAi,
  getModelPreset,
  registerProvider,
  getProvider,
  deepSeekProvider,
  ollamaProvider,
  anthropicProvider,
  geminiProvider
  , createFauxProvider,
  fauxProvider
} from '@inkpi/ai';
import type { AgentMessage, AssistantMessageEvent } from '@inkpi/protocol';

describe('@inkpi/ai', () => {
  function responseFrom(chunks: string[]) {
    return {
      ok: true,
      body: new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        }
      })
    } as any;
  }

  it('should collect AssistantMessage from AssistantEventStream', async () => {
    const stream = new AssistantEventStream();

    stream.push({ type: 'thinking_delta', thinkingDelta: '正在构思剧情...' });
    stream.push({ type: 'text_delta', textDelta: '长风' });
    stream.push({ type: 'text_delta', textDelta: '吹过落叶。' });
    stream.push({
      type: 'usage',
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30, reasoningTokens: 5 }
    });
    stream.end();

    const msg = await stream.collect();
    expect(msg.role).toBe('assistant');
    expect(msg.content.length).toBe(2);
    expect(msg.content[0]).toEqual({ type: 'thinking', thinking: '正在构思剧情...' });
    expect(msg.content[1]).toEqual({ type: 'text', text: '长风吹过落叶。' });
    expect(msg.stopReason).toBe('stop');
    expect(msg.usage?.totalTokens).toBe(30);
  });

  it('should handle tool call stream events in AssistantEventStream', async () => {
    const stream = new AssistantEventStream();

    stream.push({ type: 'tool_call_start', toolCallId: 't1', toolName: 'codex_lookup' });
    stream.push({ type: 'tool_call_delta', toolCallId: 't1', argsDelta: '{"query":' });
    stream.push({ type: 'tool_call_delta', toolCallId: 't1', argsDelta: '"青萍剑"}' });
    stream.push({
      type: 'tool_call_end',
      toolCall: { type: 'toolCall', id: 't1', name: 'codex_lookup', arguments: { query: '青萍剑' } }
    });
    stream.end();

    const msg = await stream.collect();
    expect(msg.stopReason).toBe('tool_use');
    expect(msg.content[0]).toEqual({
      type: 'toolCall',
      id: 't1',
      name: 'codex_lookup',
      arguments: { query: '青萍剑' }
    });
  });

  it('should reject malformed or structurally invalid tool call streams', async () => {
    const malformed = new AssistantEventStream();
    malformed.push({ type: 'tool_call_start', toolCallId: 'bad', toolName: 'lookup' });
    malformed.push({ type: 'tool_call_delta', toolCallId: 'bad', argsDelta: '{"query":' });
    malformed.push({
      type: 'tool_call_end',
      toolCall: { type: 'toolCall', id: 'bad', name: 'lookup', arguments: {} }
    });
    malformed.end();
    const malformedMessage = await malformed.collect();
    expect(malformedMessage.stopReason).toBe('error');
    expect(malformedMessage.errorMessage).toContain('malformed JSON arguments');
    expect(malformedMessage.content.some((content) => content.type === 'toolCall')).toBe(false);

    const missingStart = new AssistantEventStream();
    missingStart.push({ type: 'tool_call_delta', toolCallId: 'missing', argsDelta: '{}' });
    missingStart.end();
    const missingStartMessage = await missingStart.collect();
    expect(missingStartMessage.stopReason).toBe('error');
    expect(missingStartMessage.errorMessage).toContain('before start');

    const emptyName = new AssistantEventStream();
    emptyName.push({ type: 'tool_call_start', toolCallId: 'empty-name', toolName: '' });
    emptyName.push({ type: 'tool_call_delta', toolCallId: 'empty-name', argsDelta: '{}' });
    emptyName.end();
    const emptyNameMessage = await emptyName.collect();
    expect(emptyNameMessage.stopReason).toBe('error');
    expect(emptyNameMessage.errorMessage).toContain('missing a tool name');

    const duplicateEnd = new AssistantEventStream();
    duplicateEnd.push({ type: 'tool_call_start', toolCallId: 'duplicate-end', toolName: 'lookup' });
    duplicateEnd.push({
      type: 'tool_call_end',
      toolCall: { type: 'toolCall', id: 'duplicate-end', name: 'lookup', arguments: {} }
    });
    duplicateEnd.push({
      type: 'tool_call_end',
      toolCall: { type: 'toolCall', id: 'duplicate-end', name: 'lookup', arguments: {} }
    });
    duplicateEnd.end();
    const duplicateEndMessage = await duplicateEnd.collect();
    expect(duplicateEndMessage.stopReason).toBe('error');
    expect(duplicateEndMessage.errorMessage).toContain('Duplicate tool call end');

    const missingEnd = new AssistantEventStream();
    missingEnd.push({ type: 'tool_call_start', toolCallId: 'missing-end', toolName: 'lookup' });
    missingEnd.push({ type: 'tool_call_delta', toolCallId: 'missing-end', argsDelta: '{"query":"x"}' });
    missingEnd.end();
    const missingEndMessage = await missingEnd.collect();
    expect(missingEndMessage.stopReason).toBe('error');
    expect(missingEndMessage.errorMessage).toContain('without a tool_call_end');
  });

  it('should handle error events in AssistantEventStream', async () => {
    const stream = new AssistantEventStream();
    stream.error('Network timeout');

    const msg = await stream.collect();
    expect(msg.stopReason).toBe('error');
    expect(msg.errorMessage).toBe('Network timeout');
  });

  it('should handle stream abort', async () => {
    const stream = new AssistantEventStream();
    stream.abort();

    const msg = await stream.collect();
    expect(msg.stopReason).toBe('aborted');
  });

  it('should convert AgentMessages to StandardLlmMessages', () => {
    const msgs: AgentMessage[] = [
      { role: 'user', content: '开篇怎么写？' },
      { role: 'assistant', content: [{ type: 'text', text: '可以从雨夜切入。' }] },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'test', content: [{ type: 'text', text: 'ok' }] }
    ];

    const standard = convertMessagesToStandard(msgs, '系统提示词');
    expect(standard.length).toBe(4);
    expect(standard[0]).toEqual({ role: 'system', content: '系统提示词' });
    expect(standard[1]).toEqual({ role: 'user', content: '开篇怎么写？' });
    expect(standard[2]).toEqual({ role: 'assistant', content: '可以从雨夜切入。' });
    expect(standard[3]).toEqual({ role: 'tool', toolCallId: 'c1', content: 'ok' });
  });

  it('should preserve assistant tool calls for the next provider request', () => {
    const standard = convertMessagesToStandard([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '先查一下。' },
          { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { query: 'x' } }
        ]
      },
      {
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'lookup',
        content: [{ type: 'text', text: 'found' }]
      }
    ]);

    expect(standard).toEqual([
      {
        role: 'assistant',
        content: '先查一下。',
        toolCalls: [{
          id: 'call-1',
          type: 'function',
          function: { name: 'lookup', arguments: '{"query":"x"}' }
        }]
      },
      { role: 'tool', toolCallId: 'call-1', content: 'found' }
    ]);
  });

  it('should test deepSeekProvider with mocked fetch SSE stream', async () => {
    const sseChunks = [
      'data: {"choices":[{"delta":{"reasoning_content":"思考深度因果"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"天道苍茫"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":10,"completion_tokens":20,"total_tokens":30}}\n\n',
      'data: [DONE]\n\n'
    ];

    const mockReadableStream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      }
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockReadableStream
    }) as any;

    try {
      const stream = deepSeekProvider(
        { id: 'deepseek-reasoner', name: 'DeepSeek', provider: 'deepseek', apiKey: 'sk-test' },
        [{ role: 'user', content: '推导剧情' }]
      );

      const msg = await stream.collect();
      expect(msg.role).toBe('assistant');
      expect(msg.content.some((c) => c.type === 'thinking')).toBe(true);
      expect(msg.content.some((c) => c.type === 'text')).toBe(true);
      expect(msg.usage?.totalTokens).toBe(30);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should preserve OpenAI-compatible events split across chunks and inspect the request contract', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(responseFrom([
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"hel',
      'lo"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: {"usage":{"prompt_tokens":11,"completion_tokens":13,"total_tokens":24}}\n\n',
      'data: [DONE]\n\n'
    ]));
    globalThis.fetch = fetchMock as any;

    try {
      const stream = deepSeekProvider(
        { id: 'deepseek-chat', name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://provider.test/v1', apiKey: 'sk-contract' },
        [{ role: 'user', content: 'request text', timestamp: 1 }],
        { systemPrompt: 'system text', temperature: 0.2, maxTokens: 99 }
      );
      const msg = await stream.collect();

      expect(msg.content).toEqual([
        { type: 'thinking', thinking: 'think' },
        { type: 'text', text: 'hello' }
      ]);
      expect(msg.usage?.inputTokens).toBe(11);
      expect(msg.usage?.outputTokens).toBe(13);
      expect(msg.usage?.totalTokens).toBe(24);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://provider.test/v1/chat/completions');
      expect(request.headers).toEqual({
        'Content-Type': 'application/json',
        Authorization: 'Bearer sk-contract'
      });
      expect(JSON.parse(request.body as string)).toMatchObject({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'system text' },
          { role: 'user', content: 'request text' }
        ],
        stream: true,
        temperature: 0.2,
        max_tokens: 99
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should map assistant tool calls and tool results to OpenAI wire fields', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(responseFrom([
      'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n'
    ]));
    globalThis.fetch = fetchMock as any;

    try {
      await deepSeekProvider(
        { id: 'deepseek-chat', name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://provider.test/v1', apiKey: 'sk-test' },
        [
          { role: 'system', content: 'system rule' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will look it up.' },
              { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { query: 'x' } }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'lookup',
            content: [{ type: 'text', text: 'found' }]
          }
        ],
        {
          tools: [{ name: 'lookup', description: 'Look up a value', parameters: { type: 'object' } }]
        }
      ).collect();

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(body.messages).toEqual([
        { role: 'system', content: 'system rule' },
        {
          role: 'assistant',
          content: 'I will look it up.',
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"x"}' }
          }]
        },
        { role: 'tool', content: 'found', tool_call_id: 'call-1' }
      ]);
      expect(JSON.stringify(body.messages)).not.toContain('toolCalls');
      expect(JSON.stringify(body.messages)).not.toContain('toolCallId');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should turn a malformed OpenAI-compatible event into an explicit stream error', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(responseFrom(['data: {"choices":[oops]}\n\n'])) as any;
    try {
      const msg = await deepSeekProvider(
        { id: 'deepseek-chat', name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://provider.test/v1', apiKey: 'sk-test' },
        [{ role: 'user', content: 'prompt' }]
      ).collect();
      expect(msg.stopReason).toBe('error');
      expect(msg.errorMessage).toContain('Malformed deepseek stream event');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should process tool-call deltas in the final OpenAI-compatible SSE line', async () => {
    const originalFetch = globalThis.fetch;
    const observedEvents: string[] = [];
    globalThis.fetch = vi.fn().mockResolvedValue(responseFrom([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-final","function":{"name":"lookup","arguments":"{\\"q\\":\\"x\\"}"}}]}}]}'
    ])) as any;

    try {
      const stream = deepSeekProvider(
        { id: 'deepseek-chat', name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://provider.test/v1', apiKey: 'sk-test' },
        [{ role: 'user', content: 'prompt' }]
      );
      stream.on((event) => observedEvents.push(event.type));
      const message = await stream.collect();
      expect(observedEvents).toContain('tool_call_start');
      expect(observedEvents).toContain('tool_call_delta');
      expect(message.stopReason).toBe('error');
      expect(message.errorMessage).toContain('[DONE]');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should combine Anthropic message_start/message_delta usage and parse a final event without newline', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(responseFrom([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":17}}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"plan"}}\n\n',
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"result"}}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":19}}\n\n',
      'data: {"type":"message_stop"}'
    ]));
    globalThis.fetch = fetchMock as any;

    try {
      const msg = await anthropicProvider(
        { id: 'claude-test', name: 'Claude', provider: 'claude', baseUrl: 'https://provider.test/v1', apiKey: 'anthropic-key', supportsThinking: true },
        [{ role: 'user', content: 'prompt' }],
        { systemPrompt: 'system', thinkingBudget: 2048 }
      ).collect();
      expect(msg.content).toEqual([
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'result' }
      ]);
      expect(msg.usage?.inputTokens).toBe(17);
      expect(msg.usage?.outputTokens).toBe(19);
      expect(msg.usage?.totalTokens).toBe(36);
      const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://provider.test/v1/messages');
      expect(request.headers).toMatchObject({
        'x-api-key': 'anthropic-key',
        'anthropic-version': '2023-06-01'
      });
      expect(JSON.parse(request.body as string)).toMatchObject({ model: 'claude-test', stream: true, system: [{ type: 'text', text: 'system' }] });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should map Anthropic tool_use history and tool_result history to content blocks', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(responseFrom([
      'data: {"type":"message_stop"}\n\n'
    ]));
    globalThis.fetch = fetchMock as any;

    try {
      await anthropicProvider(
        { id: 'claude-test', name: 'Claude', provider: 'claude', baseUrl: 'https://provider.test/v1', apiKey: 'key' },
        [
          { role: 'system', content: 'history system' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will look it up.' },
              { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: { query: 'x' } }
            ]
          },
          {
            role: 'toolResult',
            toolCallId: 'call-1',
            toolName: 'lookup',
            content: [{ type: 'text', text: 'found' }]
          }
        ],
        { systemPrompt: 'request system' }
      ).collect();

      const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(body.system).toEqual([{ type: 'text', text: 'history system\n\nrequest system' }]);
      expect(body.messages).toEqual([
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will look it up.' },
            { type: 'tool_use', id: 'call-1', name: 'lookup', input: { query: 'x' } }
          ]
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'found' }]
        }
      ]);
      expect(JSON.stringify(body.messages)).not.toContain('toolCallId');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should parse Anthropic streamed tool_use blocks into a tool call message', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(responseFrom([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":4}}}\n\n',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-2","name":"lookup","input":{}}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":\\"x\\"}"}}\n\n',
      'data: {"type":"content_block_stop","index":0}\n\n',
      'data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n',
      'data: {"type":"message_stop"}\n\n'
    ])) as any;

    try {
      const message = await anthropicProvider(
        { id: 'claude-test', name: 'Claude', provider: 'claude', baseUrl: 'https://provider.test/v1', apiKey: 'key' },
        [{ role: 'user', content: 'look it up' }]
      ).collect();
      expect(message.stopReason).toBe('tool_use');
      expect(message.content).toEqual([
        { type: 'toolCall', id: 'call-2', name: 'lookup', arguments: { query: 'x' } }
      ]);
      expect(message.usage).toMatchObject({ inputTokens: 4, outputTokens: 2, totalTokens: 6 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should parse Gemini thought/text and usage through a configured endpoint', async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(responseFrom([
      'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"reason"},{"text":"answer"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":4,"totalTokenCount":7}}'
    ]));
    globalThis.fetch = fetchMock as any;
    try {
      const msg = await geminiProvider(
        { id: 'gemini-test', name: 'Gemini', provider: 'gemini', baseUrl: 'https://provider.test/v1beta', apiKey: 'key with spaces' },
        [{ role: 'user', content: 'prompt' }]
      ).collect();
      expect(msg.stopReason).toBe('stop');
      expect(msg.content).toEqual([
        { type: 'thinking', thinking: 'reason' },
        { type: 'text', text: 'answer' }
      ]);
      expect(msg.usage?.totalTokens).toBe(7);
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://provider.test/v1beta/models/gemini-test:streamGenerateContent?alt=sse&key=key%20with%20spaces');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should test ollamaProvider with mocked fetch stream', async () => {
    const ollamaChunks = [
      '{"message":{"content":"本地离线大模型生成"},"done":false}\n',
      '{"message":{"content":"续篇完毕"},"done":true,"prompt_eval_count":15,"eval_count":25}\n'
    ];

    const mockReadableStream = new ReadableStream({
      start(controller) {
        for (const chunk of ollamaChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      }
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: mockReadableStream
    }) as any;

    try {
      const stream = ollamaProvider(
        { id: 'qwen2.5', name: 'Ollama', provider: 'ollama' },
        [{ role: 'user', content: '写一段' }]
      );

      const msg = await stream.collect();
      expect(msg.role).toBe('assistant');
      expect(msg.content.some((c) => c.type === 'text' && c.text.includes('本地离线'))).toBe(true);
      expect(msg.usage?.totalTokens).toBe(40);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should parse Ollama EOF JSON without a newline and report malformed JSONL', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(responseFrom([
      '{"message":{"content":"final"},"done":true,"prompt_eval_count":2,"eval_count":3}'
    ])) as any;
    try {
      const msg = await ollamaProvider(
        { id: 'local', name: 'Local', provider: 'ollama', baseUrl: 'http://ollama.test' },
        [{ role: 'user', content: 'prompt' }]
      ).collect();
      expect(msg.content).toEqual([{ type: 'text', text: 'final' }]);
      expect(msg.usage).toMatchObject({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
    } finally {
      globalThis.fetch = originalFetch;
    }

    globalThis.fetch = vi.fn().mockResolvedValue(responseFrom(['not-json\n'])) as any;
    try {
      const msg = await ollamaProvider(
        { id: 'local', name: 'Local', provider: 'ollama', baseUrl: 'http://ollama.test' },
        [{ role: 'user', content: 'prompt' }]
      ).collect();
      expect(msg.stopReason).toBe('error');
      expect(msg.errorMessage).toContain('Malformed Ollama stream event');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should reject provider streams that end without their protocol terminal event', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = vi.fn().mockResolvedValue(responseFrom([
        'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
      ])) as any;
      const openAiMessage = await deepSeekProvider(
        { id: 'deepseek-chat', name: 'DeepSeek', provider: 'deepseek', baseUrl: 'https://provider.test/v1', apiKey: 'sk-test' },
        [{ role: 'user', content: 'prompt' }]
      ).collect();
      expect(openAiMessage.stopReason).toBe('error');
      expect(openAiMessage.errorMessage).toContain('[DONE]');

      globalThis.fetch = vi.fn().mockResolvedValue(responseFrom([
        'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n'
      ])) as any;
      const anthropicMessage = await anthropicProvider(
        { id: 'claude-test', name: 'Claude', provider: 'claude', baseUrl: 'https://provider.test/v1', apiKey: 'key' },
        [{ role: 'user', content: 'prompt' }]
      ).collect();
      expect(anthropicMessage.stopReason).toBe('error');
      expect(anthropicMessage.errorMessage).toContain('message_stop');

      globalThis.fetch = vi.fn().mockResolvedValue(responseFrom([
        'data: {"candidates":[{"content":{"parts":[{"text":"partial"}]}}]}'
      ])) as any;
      const geminiMessage = await geminiProvider(
        { id: 'gemini-test', name: 'Gemini', provider: 'gemini', baseUrl: 'https://provider.test/v1beta', apiKey: 'key' },
        [{ role: 'user', content: 'prompt' }]
      ).collect();
      expect(geminiMessage.stopReason).toBe('error');
      expect(geminiMessage.errorMessage).toContain('finishReason');

      globalThis.fetch = vi.fn().mockResolvedValue(responseFrom([
        '{"message":{"content":"partial"},"done":false}\n'
      ])) as any;
      const ollamaMessage = await ollamaProvider(
        { id: 'local', name: 'Local', provider: 'ollama', baseUrl: 'http://ollama.test' },
        [{ role: 'user', content: 'prompt' }]
      ).collect();
      expect(ollamaMessage.stopReason).toBe('error');
      expect(ollamaMessage.errorMessage).toContain('done: true');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('should test preset model resolution', () => {
    const preset1 = getModelPreset('creative-pro');
    expect(preset1.id).toBe('deepseek-chat');

    const preset2 = getModelPreset('deep-reasoning');
    expect(preset2.supportsThinking).toBe(true);

    expect(() => getModelPreset('unknown-preset')).toThrow(/Unknown model preset/);
  });

  it('should keep faux responses instance-scoped and omit usage unless scripted', async () => {
    const providerA = createFauxProvider({ text: 'A' });
    const providerB = createFauxProvider({
      text: 'B',
      usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }
    });

    const messageA = await providerA(
      { id: 'a', name: 'A', provider: 'faux' },
      [{ role: 'user', content: 'prompt-a' }]
    ).collect();
    const messageB = await providerB(
      { id: 'b', name: 'B', provider: 'faux' },
      [{ role: 'user', content: 'prompt-b' }]
    ).collect();

    expect(messageA.content).toEqual([{ type: 'text', text: 'A' }]);
    expect(messageA.usage).toBeUndefined();
    expect(messageB.content).toEqual([{ type: 'text', text: 'B' }]);
    expect(messageB.usage).toEqual({ inputTokens: 2, outputTokens: 3, totalTokens: 5 });
  });

  it('should reject faux calls without an explicit script', async () => {
    const message = await fauxProvider(
      { id: 'no-script', name: 'No Script', provider: 'faux' },
      [{ role: 'user', content: 'prompt' }]
    ).collect();

    expect(message.stopReason).toBe('error');
    expect(message.errorMessage).toContain('explicit scripted response');
  });
});
