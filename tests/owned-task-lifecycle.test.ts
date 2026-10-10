import {
  InMemoryTaskExecutionStore,
  TaskBatchHandler,
  TaskRegistry,
  TaskRouter,
  TaskScheduler
} from '@inkpi/agent-core';
import type { TaskExecutionRecord } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { InkPiDaemon, InkRpcClient, SqliteTaskExecutionStore } from '@inkpi/server';
import { InkDb } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

function chapter(id: string, background = false): AiTask {
  return {
    id,
    kind: 'chapter.check',
    input: { text: id },
    ...(background ? { executionPolicy: { mode: 'background' as const } } : {})
  };
}

function batch(id: string, tasks: AiTask[]): AiTask {
  return { id, kind: 'task.batch', input: { payload: { tasks } }, outputContract: { format: 'structured' } };
}

function aborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
}

describe('owned task lifetimes', () => {
  it('runs chapter batches over TCP with one foreground slot and waits for children before completion', async () => {
    const router = new TaskRouter({ scheduler: new TaskScheduler({ maxForeground: 1 }) });
    const firstStarted = gate();
    const firstFinished = gate();
    router.registry.register({
      id: 'chapter',
      kinds: ['chapter.check'],
      execute: async ({ task }) => {
        if (task.id === 'chapter-1') {
          firstStarted.release();
          await firstFinished.promise;
        }
        return { output: { format: 'text', text: `checked ${task.id}` } };
      }
    });
    const daemon = new InkPiDaemon({ context: { taskRouter: router } });
    await daemon.start(0, '127.0.0.1');
    const client = await InkRpcClient.connectTcp(daemon.getPort(), '127.0.0.1');
    try {
      await client.submitTask(batch('book-check', [chapter('chapter-1'), chapter('chapter-2')]));
      await firstStarted.promise;
      expect(await client.getTaskStatus('book-check')).toMatchObject({ status: 'completing' });
      expect(await client.getTaskExecution('chapter-1')).toMatchObject({
        run: { parent: { taskId: 'book-check', detached: false } }
      });
      firstFinished.release();
      const result = await client.waitForTask('book-check');
      expect(result.status).toBe('completed');
      expect(result.childResults?.map((child) => child.output)).toEqual([
        { format: 'text', text: 'checked chapter-1' },
        { format: 'text', text: 'checked chapter-2' }
      ]);
    } finally {
      firstFinished.release();
      await client.close();
      await daemon.stop();
    }
  });

  it('aborts descendants before parents, drains owned cleanup, and preserves explicitly detached background work', async () => {
    const registry = new TaskRegistry();
    const grandchildStarted = gate();
    const cleanup = gate();
    const detachedStarted = gate();
    const finishDetached = gate();
    const order: string[] = [];
    let detachedSignal: AbortSignal | undefined;
    registry.register({
      id: 'tree',
      kinds: ['test.tree'],
      execute: async ({ task, signal, spawnChild }) => {
        signal.addEventListener('abort', () => order.push(task.id), { once: true });
        if (task.id === 'owner') {
          await spawnChild!({ id: 'child', kind: 'test.tree', input: {}, executionPolicy: { mode: 'background' } });
          await spawnChild!(
            { id: 'detached', kind: 'test.tree', input: {}, executionPolicy: { mode: 'background' } },
            { detached: true }
          );
        } else if (task.id === 'child') {
          await spawnChild!({
            id: 'grandchild',
            kind: 'test.tree',
            input: {},
            executionPolicy: { mode: 'background' }
          });
        } else if (task.id === 'grandchild') {
          grandchildStarted.release();
          await aborted(signal);
          await cleanup.promise;
        } else {
          detachedSignal = signal;
          detachedStarted.release();
          await finishDetached.promise;
        }
        return {};
      }
    });
    const router = new TaskRouter({ registry });
    await router.submitDurably({ id: 'owner', kind: 'test.tree', input: {} });
    await Promise.all([grandchildStarted.promise, detachedStarted.promise]);
    expect(router.cancel('owner').cancelled).toBe(true);
    expect(order).toEqual(['grandchild', 'child', 'owner']);
    let settled = false;
    const result = router.wait('owner').then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(detachedSignal?.aborted).toBe(false);
    cleanup.release();
    expect((await result).status).toBe('cancelled');
    expect(router.status('grandchild').status).toBe('cancelled');
    expect(router.status('child').status).toBe('cancelled');
    expect(router.status('detached').status).toBe('running');
    finishDetached.release();
    expect((await router.wait('detached')).status).toBe('completed');
  });

  it('fails a batch and cancels an unfinished sibling after an owned child fails', async () => {
    const registry = new TaskRegistry();
    registry.register(new TaskBatchHandler());
    const siblingStarted = gate();
    let siblingAborted = false;
    registry.register({
      id: 'chapter',
      kinds: ['chapter.check'],
      execute: async ({ task, signal }) => {
        if (task.id === 'bad') {
          await siblingStarted.promise;
          throw new Error('chapter invalid');
        }
        siblingStarted.release();
        await aborted(signal);
        siblingAborted = signal.aborted;
        return {};
      }
    });
    const router = new TaskRouter({ registry });
    await router.submitDurably(batch('failed-book', [chapter('bad', true), chapter('sibling', true)]));
    await expect(router.wait('failed-book')).resolves.toMatchObject({
      status: 'failed',
      error: { code: 'OWNED_CHILD_FAILED' },
      childResults: [
        { taskId: 'bad', status: 'failed' },
        { taskId: 'sibling', status: 'cancelled' }
      ]
    });
    expect(siblingAborted).toBe(true);
  });

  it('restores pending completion and ownership from SQLite without re-running the batch handler', async () => {
    const db = new InkDb();
    const registry = new TaskRegistry();
    const running = gate();
    let batchRuns = 0;
    const chapterRuns = new Map<string, number>();
    registry.register({
      id: 'batch',
      kinds: ['task.batch'],
      execute: (context) => {
        batchRuns++;
        return new TaskBatchHandler().execute(context);
      }
    });
    registry.register({
      id: 'chapter',
      kinds: ['chapter.check'],
      execute: async ({ task, signal }) => {
        const count = (chapterRuns.get(task.id) ?? 0) + 1;
        chapterRuns.set(task.id, count);
        if (task.id === 'chapter-2' && count === 1) {
          running.release();
          await aborted(signal);
        }
        return {};
      }
    });
    const first = new TaskRouter({ registry, executionStore: new SqliteTaskExecutionStore(db) });
    try {
      await first.submitDurably(batch('restarted-book', [chapter('chapter-1'), chapter('chapter-2')]));
      await running.promise;
      expect(first.execution('restarted-book').run?.completion?.result.status).toBe('completed');
      await first.stop();
      const restarted = new TaskRouter({ registry, executionStore: new SqliteTaskExecutionStore(db) });
      await restarted.ready;
      expect(restarted.status('restarted-book').status).toBe('interrupted');
      expect(await restarted.resume('restarted-book')).toMatchObject({ status: 'completing' });
      await expect(restarted.wait('restarted-book')).resolves.toMatchObject({
        status: 'completed',
        childResults: [
          { taskId: 'chapter-1', status: 'completed' },
          { taskId: 'chapter-2', status: 'completed' }
        ]
      });
      expect(batchRuns).toBe(1);
      expect(chapterRuns.get('chapter-1')).toBe(1);
      expect(chapterRuns.get('chapter-2')).toBe(2);
      await restarted.stop();
    } finally {
      await first.stop();
      db.close();
    }
  });

  it('rejects duplicate batch ids before admitting a child and prevents late child submissions', async () => {
    const registry = new TaskRegistry();
    registry.register(new TaskBatchHandler());
    let late!: () => Promise<unknown>;
    registry.register({
      id: 'chapter',
      kinds: ['chapter.check'],
      execute: async ({ spawnChild }) => {
        late = () => spawnChild!(chapter('late'));
        return {};
      }
    });
    const router = new TaskRouter({ registry });
    await router.submitDurably(batch('bad-batch', [chapter('duplicate'), chapter('duplicate')]));
    await expect(router.wait('bad-batch')).resolves.toMatchObject({ status: 'failed' });
    expect(() => router.status('duplicate')).toThrow('Unknown task');
    await router.submitDurably(chapter('single'));
    await router.wait('single');
    await expect(late()).rejects.toThrow('settled task handler');
    expect(() => router.status('late')).toThrow('Unknown task');
  });

  it('refuses ownership cycles during recovery', async () => {
    const store = new InMemoryTaskExecutionStore();
    for (const [id, parent] of [
      ['a', 'b'],
      ['b', 'a']
    ]) {
      store.save({
        task: chapter(id!),
        snapshot: { taskId: id!, kind: 'chapter.check', status: 'queued' },
        attempts: 0,
        updatedAt: 1,
        run: {
          id: `run:${id}`,
          taskId: id!,
          status: 'queued',
          attempts: 0,
          updatedAt: 1,
          parent: { taskId: parent!, detached: false }
        }
      } satisfies TaskExecutionRecord);
    }
    await expect(new TaskRouter({ executionStore: store }).ready).rejects.toThrow('ownership contains a cycle');
    expect(store.list().map((record) => record.snapshot.status)).toEqual(['queued', 'queued']);
  });

  it('aborts and drains owned work when persisting the parent completion fails', async () => {
    const store = new InMemoryTaskExecutionStore();
    const registry = new TaskRegistry();
    const started = gate();
    const cleanup = gate();
    let childSignal: AbortSignal | undefined;
    registry.register({
      id: 'tree',
      kinds: ['test.tree'],
      execute: async ({ task, signal, spawnChild }) => {
        if (task.id === 'owner') {
          await spawnChild!({ id: 'child', kind: 'test.tree', input: {}, executionPolicy: { mode: 'background' } });
          await started.promise;
        } else {
          childSignal = signal;
          started.release();
          await aborted(signal);
          await cleanup.promise;
        }
        return {};
      }
    });
    const failed = gate();
    const router = new TaskRouter({
      registry,
      executionStore: {
        list: () => [],
        load: (id) => store.load(id),
        save: (record) => {
          if (record.task.id === 'owner' && record.snapshot.status === 'completing') {
            failed.release();
            throw new Error('parent commit failed');
          }
          store.save(record);
        }
      }
    });
    await router.submitDurably({ id: 'owner', kind: 'test.tree', input: {} });
    await failed.promise;
    await aborted(childSignal!);
    let settled = false;
    const result = router.wait('owner').then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(childSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    cleanup.release();
    await expect(result).resolves.toMatchObject({ status: 'failed', error: { code: 'TASK_PERSISTENCE_FAILED' } });
    expect(router.status('child').status).toBe('cancelled');
  });

  it('keeps a parent completing while its child waits for input and cancels the paused child with its owner', async () => {
    const registry = new TaskRegistry();
    registry.register(new TaskBatchHandler());
    registry.register({ id: 'chapter', kinds: ['chapter.check'], execute: async () => ({ status: 'waiting-user' }) });
    const router = new TaskRouter({ registry });
    const childCreated = gate();
    router.subscribe((event) => {
      if (event.taskId === 'paused-chapter' && event.type === 'created') childCreated.release();
    });
    await router.submitDurably(batch('paused-book', [chapter('paused-chapter')]));
    await childCreated.promise;
    await expect(router.wait('paused-chapter')).resolves.toMatchObject({ status: 'waiting-user' });
    expect(router.status('paused-book').status).toBe('completing');
    expect(router.cancel('paused-book').cancelled).toBe(true);
    await expect(router.wait('paused-book')).resolves.toMatchObject({ status: 'cancelled' });
    await expect(router.wait('paused-chapter')).resolves.toMatchObject({ status: 'cancelled' });
  });
});
