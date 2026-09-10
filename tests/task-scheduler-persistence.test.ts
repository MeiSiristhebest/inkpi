import {
  type ScheduledTaskState,
  type ScheduledWork,
  TaskScheduler,
  type TaskSchedulerPersistence
} from '@inkpi/agent-core';
import { describe, expect, it, vi } from 'vitest';

class MemoryTaskSchedulerPersistence implements TaskSchedulerPersistence {
  private readonly states = new Map<string, ScheduledTaskState>();

  seed(state: ScheduledTaskState): void {
    this.states.set(state.id, clone(state));
  }

  state(id: string): ScheduledTaskState | undefined {
    const state = this.states.get(id);
    return state ? clone(state) : undefined;
  }

  load(id: string): ScheduledTaskState | undefined {
    return this.state(id);
  }

  save(state: ScheduledTaskState): void {
    this.states.set(state.id, clone(state));
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

describe('TaskScheduler persistence boundary', () => {
  it('rehydrates an enqueued task and preserves its debounce deadline', async () => {
    vi.useFakeTimers();
    try {
      const persistence = new MemoryTaskSchedulerPersistence();
      const id = 'rehydrate-debounced';
      const readyAt = Date.now() + 50;
      persistence.seed({
        id,
        mode: 'background',
        status: 'queued',
        snapshot: { id, mode: 'background', status: 'queued' },
        attempts: 0,
        readyAt
      });
      let runs = 0;
      const work: ScheduledWork<string> = {
        id,
        mode: 'background',
        debounceMs: 50,
        run: async () => {
          runs += 1;
          return 'rehydrated';
        }
      };
      const scheduler = new TaskScheduler({ persistence });
      const restored = await scheduler.rehydrate(work);
      expect(restored).toBeDefined();
      if (!restored) throw new Error('expected a rehydrated handle');

      await vi.advanceTimersByTimeAsync(49);
      expect(runs).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(restored.promise).resolves.toBe('rehydrated');
      await scheduler.flush();
      expect(persistence.state(id)).toMatchObject({ status: 'completed', snapshot: { status: 'completed' } });
      expect(runs).toBe(1);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists retry attempts and cancellation as distinct terminal outcomes', async () => {
    const persistence = new MemoryTaskSchedulerPersistence();
    const scheduler = new TaskScheduler({ persistence });
    let attempts = 0;
    const retry = scheduler.schedule({
      id: 'persisted-retry',
      mode: 'background',
      maxAttempts: 2,
      run: async () => {
        attempts += 1;
        if (attempts === 1) {
          const error = new Error('temporary') as Error & { retryable?: boolean };
          error.retryable = true;
          throw error;
        }
        return 'recovered';
      }
    });

    await expect(retry.promise).resolves.toBe('recovered');
    await scheduler.flush();
    expect(persistence.state('persisted-retry')).toMatchObject({
      status: 'completed',
      attempts: 2,
      snapshot: { status: 'completed', attempts: 2 }
    });

    let cancelledRuns = 0;
    const cancelled = scheduler.schedule({
      id: 'persisted-cancel',
      mode: 'background',
      debounceMs: 100,
      run: async () => {
        cancelledRuns += 1;
        return 'not-run';
      }
    });
    await scheduler.flush();
    expect(cancelled.cancel()).toBe(true);
    await expect(cancelled.promise).resolves.toBeUndefined();
    await scheduler.flush();
    expect(cancelledRuns).toBe(0);
    expect(persistence.state('persisted-cancel')).toMatchObject({
      status: 'cancelled',
      snapshot: { status: 'cancelled' }
    });
    await scheduler.stop();
  });

  it('rehydrates an interrupted checkpoint and resumes it in a new scheduler instance', async () => {
    const persistence = new MemoryTaskSchedulerPersistence();
    let runCount = 0;
    const work: ScheduledWork<string> = {
      id: 'persisted-resume',
      mode: 'foreground',
      run: async (signal, _reportProgress, reportCheckpoint, resumeFrom) => {
        runCount += 1;
        if (resumeFrom) return `resumed:${resumeFrom.step}`;
        reportCheckpoint?.({ step: 'chapter-7', data: { offset: 12 } });
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'interrupted';
      }
    };
    const firstScheduler = new TaskScheduler({ persistence });
    const initial = firstScheduler.schedule(work);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await firstScheduler.flush();
    expect(persistence.state(work.id)).toMatchObject({
      status: 'running',
      snapshot: { status: 'running', checkpoint: { step: 'chapter-7', data: { offset: 12 } } }
    });

    expect(firstScheduler.interrupt(work.id)).toBe(true);
    await expect(initial.promise).resolves.toBeUndefined();
    await firstScheduler.flush();
    expect(persistence.state(work.id)).toMatchObject({
      status: 'interrupted',
      snapshot: { status: 'interrupted', checkpoint: { step: 'chapter-7' } }
    });

    const secondScheduler = new TaskScheduler({ persistence });
    const restored = await secondScheduler.rehydrate(work);
    expect(restored).toBeDefined();
    if (!restored) throw new Error('expected a rehydrated handle');
    expect(secondScheduler.status(work.id)).toMatchObject({
      status: 'interrupted',
      checkpoint: { step: 'chapter-7', data: { offset: 12 } }
    });

    const resumed = secondScheduler.resume<string>(work.id);
    await expect(resumed.promise).resolves.toBe('resumed:chapter-7');
    await secondScheduler.flush();
    expect(runCount).toBe(2);
    expect(persistence.state(work.id)).toMatchObject({ status: 'completed', snapshot: { status: 'completed' } });
    await firstScheduler.stop();
    await secondScheduler.stop();
  });

  it('passes a checkpoint through when a queued retry is rehydrated', async () => {
    const persistence = new MemoryTaskSchedulerPersistence();
    const id = 'queued-checkpoint';
    persistence.seed({
      id,
      mode: 'background',
      status: 'queued',
      snapshot: {
        id,
        mode: 'background',
        status: 'queued',
        attempts: 1,
        checkpoint: { step: 'chapter-9', data: { offset: 24 }, updatedAt: 100 }
      },
      attempts: 1,
      readyAt: Date.now()
    });

    let seenCheckpoint: { step: string; data?: unknown } | undefined;
    const scheduler = new TaskScheduler({ persistence });
    const restored = await scheduler.rehydrate({
      id,
      mode: 'background',
      run: async (_signal, _reportProgress, _reportCheckpoint, resumeFrom) => {
        seenCheckpoint = resumeFrom;
        return 'resumed';
      }
    });

    expect(restored).toBeDefined();
    await expect(restored?.promise).resolves.toBe('resumed');
    expect(seenCheckpoint).toEqual({ step: 'chapter-9', data: { offset: 24 }, updatedAt: 100 });
    await scheduler.stop();
  });
});
