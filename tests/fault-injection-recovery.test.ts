import {
  InMemoryTaskCheckpointStore,
  InMemoryTaskExecutionStore,
  type TaskCheckpoint,
  type TaskCheckpointStore,
  TaskRegistry,
  TaskRouter
} from '@inkpi/agent-core';
import type { AiTask, TaskResult } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

class FailOnceCheckpointStore implements TaskCheckpointStore {
  readonly inner = new InMemoryTaskCheckpointStore();
  saveCalls = 0;

  async save(checkpoint: TaskCheckpoint): Promise<void> {
    this.saveCalls += 1;
    if (this.saveCalls === 1) {
      const error = new Error('injected checkpoint write failure') as Error & { retryable?: boolean };
      error.retryable = true;
      throw error;
    }
    await this.inner.save(checkpoint);
  }

  load(taskId: string): Promise<TaskCheckpoint | undefined> {
    return Promise.resolve(this.inner.load(taskId));
  }

  clear(taskId: string): Promise<void> {
    this.inner.clear(taskId);
    return Promise.resolve();
  }
}

function makeTask(id: string, kind: string): AiTask {
  return {
    id,
    kind,
    input: { text: 'fault injection input' },
    outputContract: { format: 'text' },
    executionPolicy: { maxAttempts: 2 }
  };
}

describe('durable task fault injection and recovery', () => {
  it('retries after an injected checkpoint write failure and records the failed attempt', async () => {
    const checkpointStore = new FailOnceCheckpointStore();
    const executionStore = new InMemoryTaskExecutionStore();
    const registry = new TaskRegistry();
    registry.register({
      id: 'faulty-checkpoint-handler',
      kinds: ['test.faulty-checkpoint'],
      async execute({ saveCheckpoint }) {
        await saveCheckpoint('phase-1', { nextPhase: 'phase-2' });
        return { output: { format: 'text', text: 'recovered after checkpoint retry' } };
      }
    });
    const router = new TaskRouter({ registry, checkpointStore, executionStore });
    const task = makeTask('faulty-checkpoint-task', 'test.faulty-checkpoint');

    router.submit(task);
    const result = await router.wait(task.id);

    expect(result).toMatchObject({
      taskId: task.id,
      status: 'completed',
      output: { format: 'text', text: 'recovered after checkpoint retry' }
    } satisfies Partial<TaskResult>);
    expect(checkpointStore.saveCalls).toBe(2);
    expect(router.execution(task.id)).toMatchObject({
      run: { status: 'completed', attempts: 2 },
      executionAttempts: [
        { attempt: 1, status: 'failed', error: { message: 'injected checkpoint write failure' } },
        { attempt: 2, status: 'completed' }
      ]
    });
    await expect(checkpointStore.load(task.id)).resolves.toBeUndefined();
  });

  it('resumes a partial workflow from its durable checkpoint after an injected downstream failure', async () => {
    const checkpointStore = new InMemoryTaskCheckpointStore();
    const executionStore = new InMemoryTaskExecutionStore();
    const task = makeTask('partial-workflow-task', 'test.partial-workflow');
    await checkpointStore.save({
      taskId: task.id,
      kind: task.kind,
      step: 'chapter-12',
      data: { nextChapter: 13 },
      updatedAt: 12
    });
    const registry = new TaskRegistry();
    let attempts = 0;
    registry.register({
      id: 'partial-workflow-handler',
      kinds: [task.kind],
      async execute({ checkpoint }) {
        attempts += 1;
        expect(checkpoint).toMatchObject({ step: 'chapter-12', data: { nextChapter: 13 } });
        if (attempts === 1) {
          const error = new Error('injected downstream failure after chapter-12') as Error & {
            retryable?: boolean;
          };
          error.retryable = true;
          throw error;
        }
        const nextChapter = (checkpoint?.data as { nextChapter: number } | undefined)?.nextChapter;
        return { output: { format: 'text', text: `resumed chapter ${nextChapter}` } };
      }
    });
    const router = new TaskRouter({ registry, checkpointStore, executionStore });

    router.submit(task);
    const result = await router.wait(task.id);

    expect(result).toMatchObject({
      taskId: task.id,
      status: 'completed',
      output: { format: 'text', text: 'resumed chapter 13' }
    } satisfies Partial<TaskResult>);
    expect(attempts).toBe(2);
    expect(router.execution(task.id)).toMatchObject({
      run: { status: 'completed', attempts: 2 },
      executionAttempts: [
        { attempt: 1, status: 'failed', error: { message: 'injected downstream failure after chapter-12' } },
        { attempt: 2, status: 'completed' }
      ]
    });
    expect(checkpointStore.load(task.id)).toBeUndefined();
  });
});
