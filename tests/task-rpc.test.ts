import { InMemoryTransport as ClientInMemoryTransport, InkRpcClient as ClientInkRpcClient } from '@inkpi/client';
import type { AiTask } from '@inkpi/protocol';
import { InMemoryTransport, InkPiDaemon, InkRpcClient } from '@inkpi/server';
import { describe, expect, it } from 'vitest';

describe('task RPC surface', () => {
  it('submits, observes, and completes a task through the daemon', async () => {
    const daemon = new InkPiDaemon();
    daemon.getTaskRouter().registry.register({
      id: 'rpc-handler',
      kinds: ['test.rpc'],
      async execute({ task }) {
        return { output: { format: 'structured', data: { kind: task.kind } } };
      }
    });
    const client = new InkRpcClient(new InMemoryTransport(daemon.getRpcServer()));
    const task: AiTask = {
      id: 'rpc-task',
      kind: 'test.rpc',
      input: { payload: { source: 'test' } },
      outputContract: { format: 'structured' }
    };

    expect(await client.submitTask(task)).toEqual({ taskId: 'rpc-task', status: 'queued' });
    const result = await client.waitForTask('rpc-task');
    expect(result).toMatchObject({
      taskId: 'rpc-task',
      status: 'completed',
      output: { format: 'structured', data: { kind: 'test.rpc' } }
    });
    expect((await client.getTaskStatus('rpc-task')).status).toBe('completed');
    await client.close();
  });

  it('exposes resume, replay, and fork through the daemon RPC', async () => {
    const daemon = new InkPiDaemon();
    daemon.getTaskRouter().registry.register({
      id: 'rpc-lifecycle-handler',
      kinds: ['test.rpc.lifecycle'],
      async execute({ task }) {
        return { output: { format: 'text', text: String(task.input.text ?? 'empty') } };
      }
    });
    const client = new InkRpcClient(new InMemoryTransport(daemon.getRpcServer()));
    const task: AiTask = {
      id: 'rpc-lifecycle-task',
      kind: 'test.rpc.lifecycle',
      input: { text: 'original' },
      outputContract: { format: 'text' }
    };

    await client.submitTask(task);
    await client.waitForTask(task.id);
    await client.replayTask(task.id, 'rpc-replay');
    await client.forkTask(task.id, 'rpc-fork', { input: { text: 'forked' } });

    await expect(client.waitForTask('rpc-replay')).resolves.toMatchObject({
      output: { format: 'text', text: 'original' }
    });
    await expect(client.waitForTask('rpc-fork')).resolves.toMatchObject({
      output: { format: 'text', text: 'forked' }
    });
    expect((await client.getTaskStatus(task.id)).status).toBe('completed');
    await client.close();
  });

  it('exposes full durable execution metadata through task.execution', async () => {
    const daemon = new InkPiDaemon();
    let attempts = 0;
    daemon.getTaskRouter().registry.register({
      id: 'rpc-execution-handler',
      kinds: ['test.rpc.execution'],
      async execute({ saveCheckpoint }) {
        attempts += 1;
        await saveCheckpoint('draft', { attempt: attempts });
        throw Object.assign(new Error(`failure-${attempts}`), { retryable: true });
      }
    });
    const client = new InkRpcClient(new InMemoryTransport(daemon.getRpcServer()));
    const task: AiTask = {
      id: 'rpc-execution-task',
      kind: 'test.rpc.execution',
      input: { text: 'durable' },
      executionPolicy: { maxAttempts: 2 }
    };

    await client.submitTask(task);
    await expect(client.waitForTask(task.id)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TASK_FAILED', message: 'failure-2', retryable: true }
    });

    const execution = await client.getTaskExecution(task.id);
    expect(execution).toMatchObject({
      task: { id: task.id, kind: task.kind },
      snapshot: {
        taskId: task.id,
        status: 'failed',
        error: { code: 'TASK_FAILED', message: 'failure-2' },
        executionRunId: 'run:rpc-execution-task',
        attempts: 2,
        checkpoint: { step: 'draft' }
      },
      attempts: 2,
      run: {
        id: 'run:rpc-execution-task',
        status: 'failed',
        attempts: 2,
        resumeToken: { checkpointStep: 'draft' }
      },
      resumeToken: { checkpointStep: 'draft' }
    });
    expect(execution.executionAttempts?.map((attempt) => attempt.status)).toEqual(['failed', 'failed']);
    expect(execution.steps?.map((step) => step.status)).toEqual(['failed', 'failed']);

    const packageClient = new ClientInkRpcClient(new ClientInMemoryTransport(daemon.getRpcServer()));
    await expect(packageClient.getTaskExecution(task.id)).resolves.toMatchObject({
      snapshot: { status: 'failed', attempts: 2 },
      attempts: 2
    });
    await client.close();
    await packageClient.close();
  });

  it('preserves cancellation, checkpoint, and resumed attempt metadata', async () => {
    const daemon = new InkPiDaemon();
    let executions = 0;
    let resolveStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    daemon.getTaskRouter().registry.register({
      id: 'rpc-cancel-resume-handler',
      kinds: ['test.rpc.cancel-resume'],
      async execute({ signal, saveCheckpoint }) {
        executions += 1;
        if (executions === 1) {
          await saveCheckpoint('paused', { value: 42 });
          resolveStarted();
          await new Promise<never>((_, reject) => {
            const onAbort = () => {
              signal.removeEventListener('abort', onAbort);
              const error = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            };
            if (signal.aborted) onAbort();
            else signal.addEventListener('abort', onAbort, { once: true });
          });
        }
        return { output: { format: 'text', text: 'resumed' } };
      }
    });
    const client = new InkRpcClient(new InMemoryTransport(daemon.getRpcServer()));
    const task: AiTask = {
      id: 'rpc-cancel-resume-task',
      kind: 'test.rpc.cancel-resume',
      input: {},
      executionPolicy: { checkpoint: { enabled: true } }
    };

    await client.submitTask(task);
    await started;
    await expect(client.cancelTask(task.id)).resolves.toMatchObject({
      taskId: task.id,
      cancelled: true,
      status: 'cancelled'
    });
    await expect(client.waitForTask(task.id)).resolves.toMatchObject({ status: 'cancelled' });

    const cancelled = await client.getTaskExecution(task.id);
    expect(cancelled).toMatchObject({
      snapshot: {
        status: 'cancelled',
        attempts: 1,
        checkpoint: { step: 'paused' }
      },
      attempts: 1,
      run: { status: 'cancelled', attempts: 1 },
      resumeToken: { checkpointStep: 'paused' }
    });
    expect(cancelled.executionAttempts?.map((attempt) => attempt.status)).toEqual(['cancelled']);

    await expect(client.resumeTask(task.id)).resolves.toMatchObject({ taskId: task.id, status: 'queued' });
    await expect(client.waitForTask(task.id)).resolves.toMatchObject({ status: 'completed' });

    const resumed = await client.getTaskExecution(task.id);
    expect(resumed).toMatchObject({
      snapshot: { status: 'completed', attempts: 1 },
      attempts: 1,
      run: { status: 'completed', attempts: 1 },
      resumeToken: { checkpointStep: 'paused' }
    });
    expect(resumed.snapshot.checkpoint).toBeUndefined();
    expect(resumed.executionAttempts?.map((attempt) => attempt.status)).toEqual(['cancelled', 'completed']);
    await client.close();
  });
});
