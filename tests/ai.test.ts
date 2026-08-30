import { describe, it, expect, vi } from 'vitest';
import {
  AssistantEventStream,
  convertMessagesToStandard,
  streamAi,
  getModelPreset,
  registerProvider,
  getProvider,
  deepSeekProvider,
  ollamaProvider
} from '@inkpi/ai';
import type { AgentMessage, AssistantMessageEvent } from '@inkpi/protocol';

describe('@inkpi/ai', () => {
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

  it('should test preset model resolution', () => {
    const preset1 = getModelPreset('creative-pro');
    expect(preset1.id).toBe('deepseek-chat');

    const preset2 = getModelPreset('deep-reasoning');
    expect(preset2.supportsThinking).toBe(true);

    const presetFallback = getModelPreset('unknown-preset');
    expect(presetFallback.id).toBe('deepseek-chat');
  });
});
