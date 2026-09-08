import { TaskObservability, TaskRegistry, TaskRouter } from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

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
      }
    });
    const router = new TaskRouter({ registry, observer, now: () => now });
    router.submit({ id: 'observable', kind: 'test.observable', input: {}, outputContract: { format: 'text' } });
    await router.wait('observable');
    expect(observer.get('observable')).toMatchObject({
      status: 'completed',
      progress: 0.75,
      durationMs: 15,
      provenance: { taskId: 'observable', taskKind: 'test.observable' }
    });
  });

  it('records provider failures in the terminal observation', async () => {
    const observer = new TaskObservability(() => 10);
    const registry = new TaskRegistry();
    registry.register({
      id: 'failing-observable-handler',
      kinds: ['test.observable.failure'],
      async execute() {
        const error = new Error('provider request failed');
        (error as Error & { retryable?: boolean }).retryable = false;
        throw error;
      }
    });
    const router = new TaskRouter({ registry, observer, now: () => 10 });

    router.submit({
      id: 'observable-failure',
      kind: 'test.observable.failure',
      input: {},
      outputContract: { format: 'text' }
    });

    await expect(router.wait('observable-failure')).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TASK_FAILED', message: 'provider request failed' }
    });
    expect(observer.get('observable-failure')).toMatchObject({
      status: 'failed',
      error: { code: 'TASK_FAILED', message: 'provider request failed' }
    });
  });

  it('preserves provider identity and error fields while excluding raw CoT from failures', async () => {
    const observer = new TaskObservability(() => 10);
    const registry = new TaskRegistry();
    registry.register({
      id: 'provider-error-observable-handler',
      kinds: ['test.observable.provider-error'],
      async execute() {
        const error = new Error('upstream rate limit');
        Object.assign(error, {
          retryable: true,
          details: { provider: 'fixture-provider', rawThinking: 'must not be copied' }
        });
        throw error;
      }
    });
    const router = new TaskRouter({ registry, observer, now: () => 10 });
    router.submit({
      id: 'observable-provider-error',
      kind: 'test.observable.provider-error',
      input: {},
      metadata: {
        provider: 'fixture-provider',
        model: 'fixture-model',
        rawThinking: 'must not be observed'
      }
    });

    await expect(router.wait('observable-provider-error')).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TASK_FAILED', message: 'upstream rate limit', retryable: true }
    });
    const observation = observer.get('observable-provider-error');
    expect(observation).toMatchObject({
      provider: 'fixture-provider',
      model: 'fixture-model',
      status: 'failed',
      error: { code: 'TASK_FAILED', message: 'upstream rate limit' }
    });
    expect(observation).not.toHaveProperty('rawThinking');
    expect(JSON.stringify(observation)).not.toContain('must not be observed');
    expect(JSON.stringify(observation)).not.toContain('must not be copied');
  });
});
