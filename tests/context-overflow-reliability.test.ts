import { ContextPipeline } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

function task(maxTokens: number): AiTask {
  return {
    id: `context-overflow-${maxTokens}`,
    kind: 'test.context-overflow',
    input: { documentId: 'document-1' },
    contextPolicy: { maxTokens },
    outputContract: { format: 'text' }
  };
}

describe('context overflow reliability boundary', () => {
  it('marks a packet truncated and never exceeds the configured token budget', async () => {
    const pipeline = new ContextPipeline({ maxTokens: 3 });
    pipeline.register({
      id: 'large-context',
      provide: () => [
        { id: 'high-priority', source: 'fixture', text: '重要上下文', tokenEstimate: 2, priority: 10 },
        { id: 'low-priority', source: 'fixture', text: '低优先级上下文', tokenEstimate: 4, priority: 1 }
      ]
    });

    const packet = await pipeline.build(task(3));

    expect(packet.truncated).toBe(true);
    expect(packet.tokenEstimate).toBeLessThanOrEqual(3);
    expect(packet.fragments[0]).toMatchObject({ id: 'high-priority' });
  });

  it('keeps the overflow signal when a zero-token budget cannot accept context', async () => {
    const pipeline = new ContextPipeline({ maxTokens: 0 });
    pipeline.register({
      id: 'required-context',
      provide: () => [{ id: 'context', source: 'fixture', text: '必须保留' }]
    });

    await expect(pipeline.build(task(0))).resolves.toMatchObject({
      fragments: [],
      tokenEstimate: 0,
      truncated: true
    });
  });

  it('stops before provider execution when the task is already cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const pipeline = new ContextPipeline();
    pipeline.register({
      id: 'cancelled-context',
      provide: () => {
        calls += 1;
        return [];
      }
    });

    await expect(pipeline.build(task(3), controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(0);
  });
});
