import { TaskScheduler } from '@inkpi/agent-core';
import { describe, expect, it, vi } from 'vitest';

describe('task scheduler lifecycle', () => {
  it('limits foreground work and starts the next queued task after completion', async () => {
    const scheduler = new TaskScheduler({ maxForeground: 1 });
    let releaseFirst!: () => void;
    const first = scheduler.schedule({
      id: 'first',
      mode: 'foreground',
      run: () =>
        new Promise<string>((resolve) => {
          releaseFirst = () => resolve('first');
        })
    });
    const second = scheduler.schedule({
      id: 'second',
      mode: 'foreground',
      run: async () => 'second'
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduler.status('first').status).toBe('running');
    expect(scheduler.status('second').status).toBe('queued');
    releaseFirst();
    expect(await first.promise).toBe('first');
    expect(await second.promise).toBe('second');
  });

  it('prioritizes a ready burst and keeps ID ordering for equal priorities', async () => {
    const scheduler = new TaskScheduler({ maxForeground: 1 });
    const startOrder: string[] = [];
    let releaseBlocker!: () => void;
    let markBlockerStarted!: () => void;
    const blockerStarted = new Promise<void>((resolve) => {
      markBlockerStarted = resolve;
    });
    const blocker = scheduler.schedule({
      id: 'blocker',
      mode: 'foreground',
      run: () =>
        new Promise<string>((resolve) => {
          startOrder.push('blocker');
          markBlockerStarted();
          releaseBlocker = () => resolve('blocker');
        })
    });
    await blockerStarted;

    const low = scheduler.schedule({
      id: 'low',
      mode: 'foreground',
      priority: 0,
      run: async () => {
        startOrder.push('low');
        return 'low';
      }
    });
    const tieZ = scheduler.schedule({
      id: 'tie-z',
      mode: 'foreground',
      priority: 1,
      run: async () => {
        startOrder.push('tie-z');
        return 'tie-z';
      }
    });
    const high = scheduler.schedule({
      id: 'high',
      mode: 'foreground',
      priority: 2,
      run: async () => {
        startOrder.push('high');
        return 'high';
      }
    });
    const tieA = scheduler.schedule({
      id: 'tie-a',
      mode: 'foreground',
      priority: 1,
      run: async () => {
        startOrder.push('tie-a');
        return 'tie-a';
      }
    });

    releaseBlocker();
    await Promise.all([blocker.promise, low.promise, tieZ.promise, high.promise, tieA.promise]);

    expect(startOrder).toEqual(['blocker', 'high', 'tie-a', 'tie-z', 'low']);
    await scheduler.stop();
  });

  it('cancels queued work and transitions to stopped', async () => {
    const scheduler = new TaskScheduler();
    const work = scheduler.schedule({ id: 'queued', mode: 'background', run: async () => 'never' });
    expect(work.cancel()).toBe(true);
    expect(scheduler.status('queued').status).toBe('cancelled');
    await expect(work.promise).resolves.toBeUndefined();
    await scheduler.stop();
    expect(scheduler.lifecycle()).toBe('stopped');
  });

  it('debounces queued work until its ready time', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new TaskScheduler();
      let runs = 0;
      const work = scheduler.schedule({
        id: 'debounced',
        mode: 'background',
        debounceMs: 50,
        run: async () => {
          runs += 1;
          return 'done';
        }
      });

      await vi.advanceTimersByTimeAsync(49);
      expect(runs).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      await expect(work.promise).resolves.toBe('done');
      expect(runs).toBe(1);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('prioritizes all debounced tasks that share a ready time', async () => {
    vi.useFakeTimers();
    try {
      const scheduler = new TaskScheduler({ maxForeground: 1 });
      const startOrder: string[] = [];
      const low = scheduler.schedule({
        id: 'debounced-low',
        mode: 'foreground',
        priority: 0,
        debounceMs: 25,
        run: async () => {
          startOrder.push('low');
          return 'low';
        }
      });
      const high = scheduler.schedule({
        id: 'debounced-high',
        mode: 'foreground',
        priority: 2,
        debounceMs: 25,
        run: async () => {
          startOrder.push('high');
          return 'high';
        }
      });

      await vi.advanceTimersByTimeAsync(25);
      await Promise.all([low.promise, high.promise]);

      expect(startOrder).toEqual(['high', 'low']);
      await scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('deduplicates equivalent queued work and executes it once', async () => {
    const scheduler = new TaskScheduler();
    let runs = 0;
    const first = scheduler.schedule({
      id: 'dedupe-first',
      mode: 'foreground',
      dedupeKey: 'same-input',
      run: async () => {
        runs += 1;
        return 'first';
      }
    });
    const duplicate = scheduler.schedule({
      id: 'dedupe-second',
      mode: 'foreground',
      dedupeKey: 'same-input',
      run: async () => {
        runs += 1;
        return 'second';
      }
    });

    expect(duplicate.promise).toBe(first.promise);
    await expect(duplicate.promise).resolves.toBe('first');
    expect(runs).toBe(1);
    await scheduler.stop();
  });

  it('retries explicitly retryable work and emits a retrying event', async () => {
    const scheduler = new TaskScheduler();
    const events: string[] = [];
    scheduler.subscribe((event) => {
      events.push(event.type);
    });
    let attempts = 0;
    const work = scheduler.schedule({
      id: 'retryable',
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

    await expect(work.promise).resolves.toBe('recovered');
    expect(attempts).toBe(2);
    expect(events).toContain('retrying');
    await scheduler.stop();
  });
});
