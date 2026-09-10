import { ProviderResponseCache } from '@inkpi/server';
import type { AssistantMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('provider response cache private-data boundary', () => {
  it('removes private reasoning fields from the entire cached response', () => {
    const cache = new ProviderResponseCache({ now: () => 100, ttlMs: 1_000 });
    const response = {
      role: 'assistant',
      content: [
        { type: 'text', text: '公开答案 <think>隐藏推理</think>' },
        { type: 'thinking', thinking: '隐藏 block' }
      ],
      rawThinking: '顶层隐藏推理',
      metadata: { chain_of_thought: '嵌套隐藏推理', safe: '保留' }
    } as unknown as AssistantMessage;

    cache.set('private-response', response);
    const cached = cache.get('private-response') as unknown as Record<string, unknown>;

    expect(cached).toMatchObject({
      content: [{ type: 'text', text: '公开答案' }],
      metadata: { safe: '保留' }
    });
    expect(cached).not.toHaveProperty('rawThinking');
    expect(JSON.stringify(cached)).not.toContain('隐藏');
  });
});
