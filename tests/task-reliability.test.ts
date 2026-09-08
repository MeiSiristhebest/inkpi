import type { AiTask } from '@inkpi/protocol';
import {
  InMemoryTaskCheckpointStore,
  InMemoryTaskExecutionStore,
  TaskRegistry,
  TaskRouter,
} from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

function makeTask(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'reliability-task',
    kind: 'test.reliability',
    input: { text: 'input' },
    outputContract: { format: 'text' },
    ...overrides,
  };
}

describe('durable task reliability', () => {
  it('retries an explicitly retryable failure and records attempts', async () => {
    let attempts = 0;
    const registry = new TaskRegistry();
    registry.register({
      id: 'retry-handler',
      kinds: ['test.retry'],
      async execute() {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('temporary provider failure') as Error & { retryable?: boolean };
          error.retryable = true;
          throw error;
        }
        return { output: { format: 'text', text: 'ok' } };
      },
    });
    const router = new TaskRouter({ registry });
    router.submit(makeTask({ id: 'retry-task', kind: 'test.retry', executionPolicy: { maxAttempts: 2 } }));
    await expect(router.wait('retry-task')).resolves.toMatchObject({ status: 'completed' });
    expect(attempts).toBe(2);
    expect(router.execution('retry-task')).toMatchObject({
      run: { id: 'run:retry-task', status: 'completed', attempts: 2 },
      executionAttempts: [
        { attempt: 1, status: 'failed' },
        { attempt: 2, status: 'completed' },
      ],
    });
  });

  it('hydrates an interrupted record and resumes from its checkpoint', async () => {
    const executions = new InMemoryTaskExecutionStore();
    const checkpoints = new InMemoryTaskCheckpointStore();
    const task = makeTask({ id: 'crashed-task', kind: 'test.resume' });
    await executions.save({
      task,
      snapshot: {
        taskId: task.id,
        kind: task.kind,
        status: 'running',
        checkpoint: { step: 'chapter-147', updatedAt: 10 },
      },
      attempts: 1,
      updatedAt: 10,
    });
    await checkpoints.save({
      taskId: task.id,
      kind: task.kind,
      step: 'chapter-147',
      data: { nextChapter: 148 },
      updatedAt: 10,
    });

    const registry = new TaskRegistry();
    registry.register({
      id: 'resume-handler',
      kinds: ['test.resume'],
      async execute({ checkpoint }) {
        return { output: { format: 'text', text: String((checkpoint?.data as { nextChapter: number }).nextChapter) } };
      },
    });
    const router = new TaskRouter({ registry, executionStore: executions, checkpointStore: checkpoints });

    expect(router.status(task.id)).toMatchObject({ status: 'interrupted' });
    expect(router.status(task.id).executionRunId).toBe('run:crashed-task');
    expect(await router.resume(task.id)).toMatchObject({ status: 'queued' });
    await expect(router.wait(task.id)).resolves.toMatchObject({
      status: 'completed',
      output: { text: '148' },
    });
  });

  it('supports replay and fork without changing the original task', async () => {
    const registry = new TaskRegistry();
    registry.register({
      id: 'echo-handler',
      kinds: ['test.echo'],
      async execute({ task }) {
        return { output: { format: 'text', text: String(task.input.text) } };
      },
    });
    const router = new TaskRouter({ registry });
    const original = makeTask({ id: 'original', kind: 'test.echo' });
    router.submit(original);
    await router.wait(original.id);
    router.replay(original.id, 'replayed');
    router.fork(original.id, 'forked', { input: { text: 'fork input' } });
    await expect(router.wait('replayed')).resolves.toMatchObject({ output: { text: 'input' } });
    await expect(router.wait('forked')).resolves.toMatchObject({ output: { text: 'fork input' } });
    expect(router.getTask(original.id).id).toBe('original');
  });

  it('keeps a durable run interrupted after shutdown until it is resumed', async () => {
    let release!: () => void;
    const registry = new TaskRegistry();
    registry.register({
      id: 'non-cancellable-handler',
      kinds: ['test.interrupted'],
      execute: () => new Promise((resolve) => {
        release = () => resolve({ output: { format: 'text', text: 'late' } });
      }),
    });
    const router = new TaskRouter({ registry });
    router.submit(makeTask({
      id: 'interrupted-task',
      kind: 'test.interrupted',
      executionPolicy: { cancellable: true },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await router.stop();
    expect(router.status('interrupted-task').status).toBe('interrupted');
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.status('interrupted-task').status).toBe('interrupted');
  });
});
