import {
  InMemoryTaskCheckpointStore,
  InMemoryTaskExecutionStore,
  TaskRegistry,
  TaskRouter,
  TaskScheduler
} from '@inkpi/agent-core';
import type { TaskExecutionRecord, TaskExecutionStore } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

function makeTask(id: string, kind = 'test.durable-boundary'): AiTask {
  return {
    id,
    kind,
    input: {},
    outputContract: { format: 'text' }
  };
}

function makePersistedRecord(
  task: AiTask,
  status: TaskExecutionRecord['snapshot']['status'] = 'queued'
): TaskExecutionRecord {
  const runId = `run:${task.id}`;
  return {
    task,
    snapshot: {
      taskId: task.id,
      kind: task.kind,
      status,
      executionRunId: runId,
      attempts: 0
    },
    attempts: 0,
    updatedAt: 1,
    run: {
      id: runId,
      taskId: task.id,
      status,
      attempts: 0,
      updatedAt: 1
    }
  };
}

class DelayedListExecutionStore implements TaskExecutionStore {
  private readonly inner = new InMemoryTaskExecutionStore();
  private readonly listGate: Promise<void>;
  private releaseList!: () => void;

  constructor() {
    this.listGate = new Promise((resolve) => {
      this.releaseList = resolve;
    });
  }

  seed(record: TaskExecutionRecord): void {
    this.inner.save(record);
  }

  releaseRecovery(): void {
    this.releaseList();
  }

  async list(): Promise<TaskExecutionRecord[]> {
    await this.listGate;
    return this.inner.list();
  }

  load(taskId: string): TaskExecutionRecord | undefined {
    return this.inner.load(taskId);
  }

  save(record: TaskExecutionRecord): void {
    this.inner.save(record);
  }
}

describe('TaskRouter durable boundary', () => {
  it('gates submission during async recovery and exposes an interrupted queued record before resume', async () => {
    const task = makeTask('recovery-gated-task');
    const executions = new DelayedListExecutionStore();
    executions.seed(makePersistedRecord(task));
    const registry = new TaskRegistry();
    let handlerCalls = 0;
    registry.register({
      id: 'recovery-gated-handler',
      kinds: [task.kind],
      async execute() {
        handlerCalls += 1;
        return { output: { format: 'text', text: 'resumed' } };
      }
    });

    const router = new TaskRouter({ registry, executionStore: executions });

    expect(() => router.submit(task)).toThrow('Task router is recovering');
    executions.releaseRecovery();
    await router.ready;

    expect(handlerCalls).toBe(0);
    expect(router.status(task.id)).toMatchObject({
      status: 'interrupted',
      error: { code: 'TASK_INTERRUPTED' }
    });
    expect(executions.load(task.id)).toMatchObject({
      snapshot: { status: 'interrupted' },
      run: { status: 'interrupted' }
    });
    expect(() => router.submit(task)).toThrow(`Task already exists: ${task.id}`);

    await expect(router.resume(task.id)).resolves.toMatchObject({ status: 'queued' });
    await expect(router.wait(task.id)).resolves.toMatchObject({
      status: 'completed',
      output: { text: 'resumed' }
    });
    expect(handlerCalls).toBe(1);
  });

  it('refuses to resume when the execution snapshot declares a missing checkpoint', async () => {
    const task = makeTask('missing-checkpoint-task');
    const executions = new InMemoryTaskExecutionStore();
    const record = makePersistedRecord(task, 'failed');
    record.snapshot.checkpoint = { step: 'draft', updatedAt: 10 };
    executions.save(record);

    const router = new TaskRouter({
      executionStore: executions,
      checkpointStore: new InMemoryTaskCheckpointStore()
    });
    await router.ready;

    await expect(router.resume(task.id)).rejects.toThrow('has no durable checkpoint to resume');
    expect(router.status(task.id)).toMatchObject({
      status: 'failed',
      checkpoint: { step: 'draft' }
    });
  });

  it('refuses to resume a checkpoint whose step does not match the durable execution snapshot', async () => {
    const task = makeTask('mismatched-checkpoint-task');
    const executions = new InMemoryTaskExecutionStore();
    const checkpoints = new InMemoryTaskCheckpointStore();
    const record = makePersistedRecord(task, 'failed');
    record.snapshot.checkpoint = { step: 'draft', updatedAt: 10 };
    executions.save(record);
    checkpoints.save({
      taskId: task.id,
      kind: task.kind,
      step: 'publish',
      data: { value: 1 },
      updatedAt: 11
    });

    const router = new TaskRouter({ executionStore: executions, checkpointStore: checkpoints });
    await router.ready;

    await expect(router.resume(task.id)).rejects.toThrow('checkpoint step does not match');
    expect(router.status(task.id).status).toBe('failed');
  });

  it('keeps queued task state observable and prevents a queued handler from starting after router stop', async () => {
    const registry = new TaskRegistry();
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    let secondCalls = 0;
    registry.register({
      id: 'queued-boundary-handler',
      kinds: ['test.queued-boundary'],
      async execute({ task }) {
        if (task.id === 'first-queued-boundary-task') {
          firstStarted();
          return new Promise((resolve) => {
            releaseFirst = () => resolve({ output: { format: 'text', text: 'late' } });
          });
        }
        secondCalls += 1;
        return { output: { format: 'text', text: 'must not start' } };
      }
    });
    const executions = new InMemoryTaskExecutionStore();
    const router = new TaskRouter({
      registry,
      executionStore: executions,
      scheduler: new TaskScheduler({ maxForeground: 1 })
    });
    router.submit(makeTask('first-queued-boundary-task', 'test.queued-boundary'));
    router.submit(makeTask('second-queued-boundary-task', 'test.queued-boundary'));

    await firstStartedPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.status('first-queued-boundary-task').status).toBe('running');
    expect(router.status('second-queued-boundary-task').status).toBe('queued');
    expect(executions.load('second-queued-boundary-task')).toMatchObject({
      snapshot: { status: 'queued' },
      run: { status: 'queued' }
    });

    await router.stop();
    expect(router.status('first-queued-boundary-task').status).toBe('interrupted');
    expect(router.status('second-queued-boundary-task').status).toBe('interrupted');
    expect(executions.load('second-queued-boundary-task')).toMatchObject({
      snapshot: { status: 'interrupted' },
      run: { status: 'interrupted' }
    });

    releaseFirst();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(secondCalls).toBe(0);
  });
});
