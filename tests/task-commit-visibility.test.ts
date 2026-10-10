import { InMemoryTaskExecutionStore, type TaskExecutionStore, TaskRegistry, TaskRouter } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function task(): AiTask {
  return { id: 'commit-visible', kind: 'test.commit', input: {} };
}

describe('task commit visibility', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'exposes %s only after persistence and drains asynchronous result consumers',
    async (terminal) => {
      const committing = gate();
      const committed = gate();
      const consuming = gate();
      const consumed = gate();
      const started = gate();
      const finish = gate();
      const memory = new InMemoryTaskExecutionStore();
      const store: TaskExecutionStore = {
        list: () => [],
        load: (id) => memory.load(id),
        save: async (record) => {
          if (record.snapshot.status === terminal) {
            committing.release();
            await committed.promise;
          }
          memory.save(record);
        }
      };
      const registry = new TaskRegistry();
      registry.register({
        id: 'commit',
        kinds: [task().kind],
        execute: async () => {
          started.release();
          await finish.promise;
          if (terminal === 'failed') throw new Error('handler failed');
          return {};
        }
      });
      const router = new TaskRouter({ registry, executionStore: store });
      const events: string[] = [];
      router.subscribe(async (event) => {
        events.push(event.type);
        if (event.type === terminal) {
          event.snapshot.status = 'created';
          consuming.release();
          await consumed.promise;
        }
      });
      await router.submitDurably(task());
      await started.promise;
      if (terminal === 'cancelled') router.cancel(task().id);
      finish.release();
      await committing.promise;
      expect(router.status(task().id).status).toBe('running');
      expect(router.execution(task().id).snapshot.result).toBeUndefined();
      expect(memory.load(task().id)?.snapshot.status).toBe('running');
      expect(events).not.toContain(terminal);
      let returned = false;
      const waiting = router.wait(task().id).then((result) => {
        returned = true;
        return result;
      });
      committed.release();
      await consuming.promise;
      expect(router.status(task().id).status).toBe(terminal);
      expect(returned).toBe(false);
      consumed.release();
      expect((await waiting).status).toBe(terminal);
      expect(router.status(task().id).status).toBe(terminal);
    }
  );

  it('stops after a result write failure without advertising successful completion', async () => {
    const memory = new InMemoryTaskExecutionStore();
    const registry = new TaskRegistry();
    let executed = 0;
    let signal: AbortSignal | undefined;
    registry.register({
      id: 'commit',
      kinds: [task().kind],
      execute: async (context) => {
        executed++;
        signal = context.signal;
        return {};
      }
    });
    const router = new TaskRouter({
      registry,
      executionStore: {
        list: () => [],
        load: (id) => memory.load(id),
        save: (record) => {
          if (record.snapshot.status === 'completed') throw new Error('commit outcome unavailable');
          memory.save(record);
        }
      }
    });
    const events: string[] = [];
    router.subscribe((event) => {
      events.push(event.type);
    });
    await router.submitDurably(task());
    await expect(router.wait(task().id)).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'TASK_PERSISTENCE_FAILED' }
    });
    expect(events).not.toContain('completed');
    expect(memory.load(task().id)?.snapshot.status).toBe('running');
    expect(signal?.aborted).toBe(true);
    await expect(router.resume(task().id)).rejects.toThrow('must be restored');
    expect(executed).toBe(1);
  });

  it('keeps observer and subscriber failures from changing the accepted task', async () => {
    const registry = new TaskRegistry();
    registry.register({ id: 'commit', kinds: [task().kind], execute: async () => ({}) });
    const fail = () => {
      throw new Error('telemetry failed');
    };
    const router = new TaskRouter({ registry, observer: { started: fail, contextBuilt: fail, finished: fail } });
    router.subscribe(fail);
    await router.submitDurably(task());
    await expect(router.wait(task().id)).resolves.toMatchObject({ status: 'completed' });
    expect(router.execution(task().id).snapshot.status).toBe('completed');
  });

  it('does not make one task wait for an unrelated background task observer', async () => {
    const registry = new TaskRegistry();
    const backgroundStarted = gate();
    const observerFinished = gate();
    registry.register({ id: 'commit', kinds: [task().kind], execute: async () => ({}) });
    const router = new TaskRouter({ registry });
    router.subscribe(async (event) => {
      if (event.taskId === 'background' && event.type === 'started') {
        backgroundStarted.release();
        await observerFinished.promise;
      }
    });
    await router.submitDurably({ ...task(), id: 'background', executionPolicy: { mode: 'background' } });
    await backgroundStarted.promise;
    try {
      await router.submitDurably(task());
      await expect(router.wait(task().id)).resolves.toMatchObject({ status: 'completed' });
    } finally {
      observerFinished.release();
      await router.wait('background');
    }
  });
});
