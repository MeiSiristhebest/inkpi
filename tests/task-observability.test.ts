import { describe, expect, it } from 'vitest';
import { TaskObservability, TaskRegistry, TaskRouter } from '@inkpi/agent-core';

describe('task observability and provenance', () => {
  it('records context fingerprints, progress, duration, and terminal status', async () => {
    let now = 10;
    const observer = new TaskObservability(() => now);
    const registry = new TaskRegistry();
    registry.register({
      id: 'observable-handler',
      kinds: ['test.observable'],
      async execute({ reportProgress }) {
        reportProgress(0.75);
        now = 25;
        return { output: { format: 'text', text: 'ok' } };
      },
    });
    const router = new TaskRouter({ registry, observer, now: () => now });
    router.submit({ id: 'observable', kind: 'test.observable', input: {}, outputContract: { format: 'text' } });
    await router.wait('observable');
    expect(observer.get('observable')).toMatchObject({
      status: 'completed',
      progress: 0.75,
      durationMs: 15,
      provenance: { taskId: 'observable', taskKind: 'test.observable' },
    });
  });
});
