import type { AiTask } from '@inkpi/protocol';
import { InkPiDaemon, InkRpcClient, InMemoryTransport } from '@inkpi/server';
import { describe, expect, it } from 'vitest';

describe('task RPC surface', () => {
  it('submits, observes, and completes a task through the daemon', async () => {
    const daemon = new InkPiDaemon();
    daemon.getTaskRouter().registry.register({
      id: 'rpc-handler',
      kinds: ['test.rpc'],
      async execute({ task }) {
        return { output: { format: 'structured', data: { kind: task.kind } } };
      },
    });
    const client = new InkRpcClient(new InMemoryTransport(daemon.getRpcServer()));
    const task: AiTask = {
      id: 'rpc-task',
      kind: 'test.rpc',
      input: { payload: { source: 'test' } },
      outputContract: { format: 'structured' },
    };

    expect(await client.submitTask(task)).toEqual({ taskId: 'rpc-task', status: 'queued' });
    const result = await client.waitForTask('rpc-task');
    expect(result).toMatchObject({
      taskId: 'rpc-task',
      status: 'completed',
      output: { format: 'structured', data: { kind: 'test.rpc' } },
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
      },
    });
    const client = new InkRpcClient(new InMemoryTransport(daemon.getRpcServer()));
    const task: AiTask = {
      id: 'rpc-lifecycle-task',
      kind: 'test.rpc.lifecycle',
      input: { text: 'original' },
      outputContract: { format: 'text' },
    };

    await client.submitTask(task);
    await client.waitForTask(task.id);
    await client.replayTask(task.id, 'rpc-replay');
    await client.forkTask(task.id, 'rpc-fork', { input: { text: 'forked' } });

    await expect(client.waitForTask('rpc-replay')).resolves.toMatchObject({
      output: { format: 'text', text: 'original' },
    });
    await expect(client.waitForTask('rpc-fork')).resolves.toMatchObject({
      output: { format: 'text', text: 'forked' },
    });
    expect((await client.getTaskStatus(task.id)).status).toBe('completed');
    await client.close();
  });
});
