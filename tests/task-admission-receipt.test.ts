import { InMemoryTaskExecutionStore, TaskRegistry, TaskRouter } from '@inkpi/agent-core';
import type { TaskExecutionStore } from '@inkpi/agent-core';
import { type AiTask, observeTaskResult } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

function task(): AiTask {
  return { id: 'admitted-task', kind: 'test.admission', input: { text: 'hello' } };
}
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('durable admission receipts and independent waiters', () => {
  it('recovers an explicit request identity after completion and restart without re-executing the task', async () => {
    let calls = 0;
    const registry = new TaskRegistry();
    registry.register({
      id: 'admission',
      kinds: ['test.admission'],
      execute: async () => {
        calls++;
        return {};
      }
    });
    const store = new InMemoryTaskExecutionStore();
    const router = new TaskRouter({ registry, executionStore: store, now: () => 42 });
    await router.submitDurably(task(), 'network-request');
    await router.wait(task().id);
    const receipt = await router.admission('network-request');
    expect(receipt).toEqual({ version: 1, requestId: 'network-request', taskId: task().id, acceptedAt: 42 });
    receipt!.taskId = 'external mutation';
    const restarted = new TaskRouter({ registry, executionStore: store });
    await restarted.ready;
    expect(await restarted.admission('network-request')).toMatchObject({ taskId: task().id });
    await expect(restarted.submitDurably(task(), 'network-request')).resolves.toMatchObject({ status: 'completed' });
    await expect(restarted.submitDurably({ ...task(), input: { text: 'changed' } }, 'network-request')).rejects.toThrow(
      'different payload'
    );
    expect(await restarted.admission('unknown-request')).toBeNull();
    expect(calls).toBe(1);
  });

  it('publishes no receipt or execution before initial persistence, and none for a failed acceptance', async () => {
    const persisted = gate();
    const memory = new InMemoryTaskExecutionStore();
    const store: TaskExecutionStore = {
      list: () => [],
      load: (id) => memory.load(id),
      save: async (record) => {
        await persisted.promise;
        memory.save(record);
      }
    };
    let calls = 0;
    const registry = new TaskRegistry();
    registry.register({
      id: 'admission',
      kinds: ['test.admission'],
      execute: async () => {
        calls++;
        return {};
      }
    });
    const router = new TaskRouter({ registry, executionStore: store });
    const accepted = router.submitDurably(task(), 'delayed');
    let published = false;
    const query = router.admission('delayed').then((receipt) => {
      published = true;
      return receipt;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(published).toBe(false);
    expect(calls).toBe(0);
    persisted.release();
    await accepted;
    expect(await query).toMatchObject({ requestId: 'delayed' });
    await router.wait(task().id);
    const failing = new TaskRouter({
      registry,
      executionStore: {
        list: () => [],
        load: () => undefined,
        save: () => {
          throw new Error('write rejected');
        }
      }
    });
    await expect(failing.submitDurably(task(), 'rejected')).rejects.toThrow('write rejected');
    expect(await failing.admission('rejected')).toBeNull();
    expect(calls).toBe(1);
  });

  it('cancels only the waiting caller and allows accepted work to finish normally', async () => {
    const started = gate();
    const finish = gate();
    const registry = new TaskRegistry();
    let taskSignal: AbortSignal | undefined;
    registry.register({
      id: 'admission',
      kinds: ['test.admission'],
      execute: async ({ signal }) => {
        taskSignal = signal;
        started.release();
        await finish.promise;
        return {};
      }
    });
    const router = new TaskRouter({ registry });
    await router.submitDurably(task());
    await started.promise;
    const controller = new AbortController();
    const waiter = router.wait(task().id, controller.signal);
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });
    expect(taskSignal?.aborted).toBe(false);
    expect(router.status(task().id).status).toBe('running');
    finish.release();
    await expect(router.wait(task().id)).resolves.toMatchObject({ status: 'completed' });
  });

  it('removes client result subscriptions when their waiter is cancelled', async () => {
    let listeners = 0;
    const controller = new AbortController();
    const waiter = observeTaskResult(
      'task',
      async () => ({ taskId: 'task', kind: 'test', status: 'running' }),
      () => {
        listeners++;
        return () => {
          listeners--;
        };
      },
      controller.signal
    );
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: 'AbortError' });
    expect(listeners).toBe(0);
  });
});
