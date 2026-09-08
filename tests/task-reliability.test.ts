import {
  InMemoryTaskCheckpointStore,
  InMemoryTaskExecutionStore,
  TaskRegistry,
  TaskRouter,
} from '@inkpi/agent-core';
import type { TaskExecutionRecord, TaskExecutionStore } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

class DelayedExecutionStore implements TaskExecutionStore {
  private readonly inner = new InMemoryTaskExecutionStore();
  private readonly listGate: Promise<void>;
  private releaseList!: () => void;
  listCalls = 0;

  constructor(records: TaskExecutionRecord[]) {
    for (const record of records) this.inner.save(record);
    this.listGate = new Promise((resolve) => {
      this.releaseList = resolve;
    });
  }

  releaseRecovery(): void {
    this.releaseList();
  }

  async list(): Promise<TaskExecutionRecord[]> {
    this.listCalls += 1;
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
    const executions = new InMemoryTaskExecutionStore();
    const router = new TaskRouter({ registry, executionStore: executions });
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
    expect(executions.load('retry-task')).toMatchObject({
      snapshot: { status: 'completed', attempts: 2 },
      run: { status: 'completed', attempts: 2 },
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

    await router.ready;
    expect(router.status(task.id)).toMatchObject({ status: 'interrupted' });
    expect(router.status(task.id).executionRunId).toBe('run:crashed-task');
    expect(await router.resume(task.id)).toMatchObject({ status: 'queued' });
    await expect(router.wait(task.id)).resolves.toMatchObject({
      status: 'completed',
      output: { text: '148' },
    });
  });

  it('exposes a recovery gate and persists normalized interruption before resume', async () => {
    const task = makeTask({ id: 'delayed-recovery-task', kind: 'test.delayed-resume' });
    const runId = `run:${task.id}`;
    const executions = new DelayedExecutionStore([{
      task,
      snapshot: {
        taskId: task.id,
        kind: task.kind,
        status: 'running',
        executionRunId: runId,
        attempts: 1,
      },
      attempts: 1,
      updatedAt: 10,
      run: {
        id: runId,
        taskId: task.id,
        status: 'running',
        attempts: 1,
        updatedAt: 10,
      },
      steps: [{
        id: `step:${task.id}:1`,
        runId,
        step: 'chapter-147',
        status: 'running',
        startedAt: 10,
      }],
      executionAttempts: [{
        runId,
        attempt: 1,
        startedAt: 10,
        status: 'running',
      }],
    }]);
    const checkpoints = new InMemoryTaskCheckpointStore();
    await checkpoints.save({
      taskId: task.id,
      kind: task.kind,
      step: 'chapter-147',
      data: { nextChapter: 148 },
      updatedAt: 10,
    });
    const registry = new TaskRegistry();
    registry.register({
      id: 'delayed-resume-handler',
      kinds: [task.kind],
      async execute({ checkpoint }) {
        return {
          output: { format: 'text', text: String((checkpoint?.data as { nextChapter: number }).nextChapter) },
        };
      },
    });
    const router = new TaskRouter({ registry, executionStore: executions, checkpointStore: checkpoints });

    expect(router.whenReady()).toBe(router.ready);
    const resume = router.resume(task.id);
    await Promise.resolve();
    expect(executions.listCalls).toBe(1);
    executions.releaseRecovery();

    await router.ready;
    expect(router.status(task.id)).toMatchObject({ status: 'interrupted', executionRunId: runId });
    expect(executions.load(task.id)).toMatchObject({
      snapshot: { status: 'interrupted' },
      run: { status: 'interrupted' },
      steps: [{ status: 'interrupted' }],
      executionAttempts: [{ status: 'interrupted' }],
    });
    await expect(resume).resolves.toMatchObject({ taskId: task.id, status: 'queued' });
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
    let calls = 0;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    let release!: () => void;
    const registry = new TaskRegistry();
    const executions = new InMemoryTaskExecutionStore();
    registry.register({
      id: 'interruptible-handler',
      kinds: ['test.interrupted'],
      execute: () => {
        calls += 1;
        if (calls === 1) {
          resolveStarted();
          return new Promise((resolve) => {
            release = () => resolve({ output: { format: 'text', text: 'late' } });
          });
        }
        return Promise.resolve({ output: { format: 'text', text: 'resumed' } });
      },
    });
    const router = new TaskRouter({ registry, executionStore: executions });
    router.submit(makeTask({
      id: 'interrupted-task',
      kind: 'test.interrupted',
      executionPolicy: { cancellable: true },
    }));
    await started;
    await router.stop();
    expect(router.status('interrupted-task').status).toBe('interrupted');
    expect(executions.load('interrupted-task')).toMatchObject({
      snapshot: { status: 'interrupted' },
      run: { status: 'interrupted' },
      executionAttempts: [{ status: 'interrupted' }],
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(router.status('interrupted-task').status).toBe('interrupted');

    await router.stop();
    expect(router.status('interrupted-task').status).toBe('interrupted');
    await expect(router.resume('interrupted-task')).resolves.toMatchObject({ status: 'queued' });
    await expect(router.wait('interrupted-task')).resolves.toMatchObject({
      status: 'completed',
      output: { text: 'resumed' },
    });
    expect(router.execution('interrupted-task')).toMatchObject({
      run: { status: 'completed', attempts: 1 },
      executionAttempts: [
        { attempt: 1, status: 'interrupted' },
        { attempt: 1, status: 'completed' },
      ],
    });
  });

  it('does not duplicate recovery state when a second router starts from the same store', async () => {
    const task = makeTask({ id: 'repeat-recovery-task', kind: 'test.repeat-recovery' });
    const executions = new InMemoryTaskExecutionStore();
    const runId = `run:${task.id}`;
    executions.save({
      task,
      snapshot: {
        taskId: task.id,
        kind: task.kind,
        status: 'running',
        executionRunId: runId,
        attempts: 1,
      },
      attempts: 1,
      updatedAt: 10,
      run: { id: runId, taskId: task.id, status: 'running', attempts: 1, updatedAt: 10 },
      executionAttempts: [{ runId, attempt: 1, startedAt: 10, status: 'running' }],
    });
    const registry = new TaskRegistry();
    registry.register({
      id: 'repeat-recovery-handler',
      kinds: [task.kind],
      async execute() {
        return { output: { format: 'text', text: 'recovered once' } };
      },
    });

    const first = new TaskRouter({ registry, executionStore: executions });
    await first.ready;
    await first.ready;
    expect(first.execution(task.id).executionAttempts).toHaveLength(1);
    expect(executions.load(task.id)).toMatchObject({
      snapshot: { status: 'interrupted' },
      executionAttempts: [{ status: 'interrupted' }],
    });

    const second = new TaskRouter({ registry, executionStore: executions });
    await second.whenReady();
    expect(second.execution(task.id).executionAttempts).toHaveLength(1);
    expect(second.status(task.id).status).toBe('interrupted');
    await expect(second.resume(task.id)).resolves.toMatchObject({ status: 'queued' });
    await expect(second.wait(task.id)).resolves.toMatchObject({ status: 'completed' });
  });
});
