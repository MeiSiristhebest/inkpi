import { TaskObservability, TaskRegistry, TaskRouter, type TaskRunObservation } from '@inkpi/agent-core';
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

  it('retains and emits only sampled task runs without affecting the task path', async () => {
    const emitted: TaskRunObservation[] = [];
    const registry = new TaskRegistry();
    registry.register({
      id: 'sampled-observable-handler',
      kinds: ['test.observable.sampled'],
      async execute({ reportProgress }) {
        reportProgress(0.5);
        return { output: { format: 'text', text: 'ok' } };
      }
    });
    const observer = new TaskObservability({
      sampleRate: 0.5,
      random: () => 0.25,
      onObservation: (observation) => emitted.push(observation)
    });
    const router = new TaskRouter({ registry, observer });
    router.submit({
      id: 'sampled-observable',
      kind: 'test.observable.sampled',
      input: {},
      outputContract: { format: 'text' }
    });

    await expect(router.wait('sampled-observable')).resolves.toMatchObject({ status: 'completed' });
    expect(observer.get('sampled-observable')).toMatchObject({ status: 'completed', progress: 0.5 });
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({ taskId: 'sampled-observable', status: 'completed' });

    const unsampled = new TaskObservability({
      sampleRate: 0,
      onObservation: (observation) => emitted.push(observation)
    });
    const unsampledRouter = new TaskRouter({ registry, observer: unsampled });
    unsampledRouter.submit({
      id: 'unsampled-observable',
      kind: 'test.observable.sampled',
      input: {},
      outputContract: { format: 'text' }
    });
    await expect(unsampledRouter.wait('unsampled-observable')).resolves.toMatchObject({ status: 'completed' });
    expect(unsampled.get('unsampled-observable')).toBeUndefined();
    expect(emitted).toHaveLength(1);
  });

  it('sanitizes direct observation sinks before storing or emitting them', () => {
    const emitted: TaskRunObservation[] = [];
    const observer = new TaskObservability({
      now: () => 10,
      onObservation: (observation) => emitted.push(observation)
    });
    const task = { id: 'direct-sanitize', kind: 'test.observable.direct', input: {} };
    observer.started(task);
    const unsafe = Object.assign(
      {
        taskId: task.id,
        kind: task.kind,
        status: 'completed' as const,
        usage: { inputTokens: 1, reasoning: 'private usage reasoning', analysis: 'private usage analysis' },
        cache: { hit: false, rawThinking: 'private cache reasoning', scratchpad: 'private cache scratchpad' },
        provenance: {
          publicSummary: 'safe',
          trace: {
            reasoning: 'private nested reasoning',
            detail: { chainOfThought: 'private deep reasoning', thoughts: 'private thoughts' }
          },
          calls: [{ tool: 'fixture', rawThinking: 'private array reasoning', deliberation: 'private deliberation' }]
        }
      },
      { rawThinking: 'private top-level reasoning', hiddenThoughts: 'private hidden thoughts' }
    ) as TaskRunObservation;

    observer.finished(task, unsafe);

    const observation = observer.get(task.id);
    expect(observation).toMatchObject({
      usage: { inputTokens: 1 },
      cache: { hit: false },
      provenance: { publicSummary: 'safe', trace: { detail: {} }, calls: [{ tool: 'fixture' }] }
    });
    expect(observation).not.toHaveProperty('rawThinking');
    expect(JSON.stringify(observation)).not.toContain('private');
    expect(emitted).toHaveLength(1);
    expect(JSON.stringify(emitted[0])).not.toContain('private');
  });

  it('removes formatted private reasoning from direct observation values', () => {
    const observer = new TaskObservability({ now: () => 10 });
    const task = { id: 'formatted-private-data', kind: 'test.observable.direct', input: {} };

    observer.started(task);
    observer.finished(task, {
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      provenance: {
        publicSummary: 'safe',
        answer: 'before <think>hidden chain</think> after',
        nested: {
          chain_of_thought: 'must not persist',
          REASONING_CONTENT: 'must not persist'
        }
      }
    });

    expect(observer.get(task.id)).toMatchObject({
      provenance: {
        publicSummary: 'safe',
        answer: 'before  after',
        nested: {}
      }
    });
    expect(JSON.stringify(observer.get(task.id))).not.toContain('hidden chain');
    expect(JSON.stringify(observer.get(task.id))).not.toContain('must not persist');
  });

  it('derives skill ids and versions from instruction provenance', () => {
    const observer = new TaskObservability({ now: () => 10 });
    const task = { id: 'skill-provenance', kind: 'test.observable.direct', input: {} };

    observer.started(task);
    observer.finished(task, {
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      provenance: {
        instructionProvenance: [
          {
            id: 'instruction-hook',
            provenance: { source: 'skill:hook', skillId: 'hook', skillVersion: '1.2.0' }
          },
          {
            id: 'instruction-system',
            provenance: { source: 'system' }
          },
          {
            id: 'instruction-promise',
            provenance: { source: 'skill:promise', skillId: 'promise', skillVersion: '2.0.0' }
          }
        ]
      }
    });

    expect(observer.get(task.id)).toMatchObject({
      skillIds: ['hook', 'promise'],
      skillVersions: { hook: '1.2.0', promise: '2.0.0' }
    });
  });

  it('uses the compiled context revision before task fallbacks', () => {
    const observer = new TaskObservability({ now: () => 10 });
    const task = {
      id: 'context-revision-precedence',
      kind: 'test.observable.direct',
      input: { selection: { documentId: 'doc', from: 0, to: 1, revision: 3 } },
      metadata: { projectRevision: 2 }
    };

    observer.started(task);
    observer.contextBuilt(task, {
      fragments: [],
      text: '',
      tokenEstimate: 0,
      fingerprint: 'context-revision',
      truncated: false,
      projectRevision: 7
    });

    expect(observer.get(task.id)?.projectRevision).toBe(7);
  });
});
