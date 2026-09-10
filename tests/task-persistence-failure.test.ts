import type { TaskExecutionRecord, TaskExecutionStore } from '@inkpi/agent-core';
import { TaskRouter } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

class FailingExecutionStore implements TaskExecutionStore {
  saves = 0;

  save(): void {
    this.saves += 1;
    throw new Error('disk unavailable');
  }

  load(): undefined {
    return undefined;
  }

  list(): TaskExecutionRecord[] {
    return [];
  }
}

describe('TaskRouter persistence failures', () => {
  it('fails visibly when the initial durable execution write fails', async () => {
    const executions = new FailingExecutionStore();
    const router = new TaskRouter({ executionStore: executions });
    const task: AiTask = {
      id: 'persistence-failure-task',
      kind: 'test.persistence-failure',
      input: {},
      outputContract: { format: 'text' }
    };

    router.submit(task);

    await expect(router.wait(task.id)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TASK_PERSISTENCE_FAILED', retryable: true }
    });
    expect(router.status(task.id)).toMatchObject({
      status: 'failed',
      error: { code: 'TASK_PERSISTENCE_FAILED' }
    });
    expect(executions.saves).toBe(1);
  });
});
