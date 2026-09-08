import { describe, expect, it } from 'vitest';
import { TaskScheduler } from '@inkpi/agent-core';

describe('task scheduler lifecycle', () => {
  it('limits foreground work and starts the next queued task after completion', async () => {
    const scheduler = new TaskScheduler({ maxForeground: 1 });
    let releaseFirst!: () => void;
    const first = scheduler.schedule({
      id: 'first',
      mode: 'foreground',
      run: () => new Promise<string>((resolve) => (releaseFirst = () => resolve('first'))),
    });
    const second = scheduler.schedule({
      id: 'second',
      mode: 'foreground',
      run: async () => 'second',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(scheduler.status('first').status).toBe('running');
    expect(scheduler.status('second').status).toBe('queued');
    releaseFirst();
    expect(await first.promise).toBe('first');
    expect(await second.promise).toBe('second');
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
});
