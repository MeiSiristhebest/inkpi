import {
  anthropicProvider,
  convertMessagesToAnthropic,
  fauxProvider,
  getModelPreset,
  insertThinkingLevelMessages,
  mapThinkingLevelToEffort,
  type AnthropicWireMessage
} from '@inkpi/ai';
import { Agent } from '@inkpi/agent-core';
import type { AgentMessage } from '@inkpi/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

const SSE_OK = [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
  'data: {"type":"message_stop"}'
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('@inkpi/ai -> Anthropic per-turn thinking effort (aligned with pi v0.85.0 #4e69b0c28)', () => {
  it('maps ThinkingLevel to Anthropic effort levels like upstream', () => {
    expect(mapThinkingLevelToEffort('minimal')).toBe('low');
    expect(mapThinkingLevelToEffort('low')).toBe('low');
    expect(mapThinkingLevelToEffort('medium')).toBe('medium');
    expect(mapThinkingLevelToEffort('high')).toBe('high');
    // 原生 xhigh 仅特定模型支持，未列档位统一回落 high（对齐上游）。
    expect(mapThinkingLevelToEffort('xhigh')).toBe('high');
    expect(mapThinkingLevelToEffort('max')).toBe('high');
    expect(mapThinkingLevelToEffort(undefined)).toBe('high');
  });

  it('records per-assistant providerThinkingLevel during conversion', () => {
    const messages: AgentMessage[] = [
      { id: 'u1', role: 'user', content: '第一轮' },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: '回答一' }],
        providerThinkingLevel: 'low',
        timestamp: 1
      },
      { id: 'u2', role: 'user', content: '第二轮' },
      {
        id: 'a2',
        role: 'assistant',
        content: [{ type: 'text', text: '回答二' }],
        providerThinkingLevel: 'high',
        timestamp: 2
      }
    ];

    const conversion = convertMessagesToAnthropic(messages);
    // 转换数组按 user/assistant 顺序占位：a1 -> 下标 1，a2 -> 下标 3。
    expect(conversion.assistantLevels.size).toBe(2);
    expect(conversion.assistantLevels.get(1)).toBe('low');
    expect(conversion.assistantLevels.get(3)).toBe('high');
  });

  it('inserts historical effort entries and the active effort entry', () => {
    const converted: AnthropicWireMessage[] = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [{ type: 'text', text: 'a1' }] },
      { role: 'user', content: 'q2' }
    ];
    const assistantLevels = new Map<number, string>([[1, 'low']]);

    const messages = insertThinkingLevelMessages(converted, assistantLevels, 'high');

    expect(messages).toHaveLength(5);
    expect(messages[1]).toEqual({ role: 'system', content: [], output_config: { effort: 'low' } });
    expect(messages[4]).toEqual({ role: 'system', content: [], output_config: { effort: 'high' } });
  });

  it('uses adaptive thinking with output_config.effort and per-turn replay entries in effort mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseFrom(SSE_OK));
    vi.stubGlobal('fetch', fetchMock);

    const model = {
      id: 'claude-adaptive',
      name: 'Claude Adaptive',
      provider: 'claude' as const,
      baseUrl: 'https://provider.test/v1',
      apiKey: 'anthropic-key',
      supportsMidConvoEffort: true
    };
    const messages: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'q1' },
      {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'text', text: 'a1' }],
        providerThinkingLevel: 'low',
        timestamp: 1
      },
      { id: 'u2', role: 'user', content: 'q2' }
    ];

    await anthropicProvider(model, messages, { thinkingEffort: 'high' }).collect();

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(request.body as string);
    expect(body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(body.output_config).toEqual({ effort: 'high' });
    // 逐轮回放：a1 前插入 low 档位，末尾插入本轮 high。
    expect(body.messages[1]).toEqual({ role: 'system', content: [], output_config: { effort: 'low' } });
    expect(body.messages[body.messages.length - 1]).toEqual({
      role: 'system',
      content: [],
      output_config: { effort: 'high' }
    });
  });

  it('keeps budget-based thinking for non-effort models and clamps budget under max_tokens', async () => {
    const fetchMock = vi.fn().mockResolvedValue(responseFrom(SSE_OK));
    vi.stubGlobal('fetch', fetchMock);

    const model = {
      id: 'claude-budget',
      name: 'Claude Budget',
      provider: 'claude' as const,
      baseUrl: 'https://provider.test/v1',
      apiKey: 'anthropic-key',
      supportsThinking: true
    };

    await anthropicProvider(model, [{ role: 'user', content: 'q' }], {
      thinkingBudget: 32768,
      maxTokens: 4096
    }).collect();

    const [, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(request.body as string);
    // budget_tokens 必须小于 max_tokens：预留 1024 输出空间（对齐上游 pi）。
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 3072 });
    expect(body.output_config).toBeUndefined();
  });

  it('agent records providerThinkingLevel on assistant messages when the model supports mid-convo effort', async () => {
    const captured: any[] = [];
    const preset = getModelPreset('mock-test');
    const agent = new Agent({
      initialState: { model: { ...preset, supportsMidConvoEffort: true }, thinkingLevel: 'medium' },
      streamFn: (model, messages, options) => {
        captured.push(options);
        return fauxProvider(model, messages, options);
      }
    });

    try {
      await agent.prompt('写一句话');
    } finally {
      agent.abort();
    }

    expect(captured.length).toBeGreaterThan(0);
    expect(captured[0].thinkingEffort).toBe('medium');
    expect(captured[0].thinkingBudget).toBeUndefined();
    const assistant = agent.state.messages.find((m) => m.role === 'assistant');
    expect((assistant as any)?.providerThinkingLevel).toBe('medium');
  });
});
