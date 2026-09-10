import { type ScheduledCheckpoint, type SchedulerEvent, TaskScheduler } from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

const flush = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
};

describe('TaskScheduler checkpoint/resume/interrupted lifecycle', () => {
  it('emits a checkpoint, interrupts the active run, and resumes from that checkpoint', async () => {
    const scheduler = new TaskScheduler();
    const events: SchedulerEvent[] = [];
    scheduler.subscribe((event) => {
      events.push(event);
    });
    let runCount = 0;
    let resumedFrom: ScheduledCheckpoint | undefined;

    const initial = scheduler.schedule<string>({
      id: 'resume-me',
      mode: 'foreground',
      run: async (signal, _reportProgress, reportCheckpoint, resumeCheckpoint) => {
        runCount += 1;
        resumedFrom = resumeCheckpoint;
        if (resumeCheckpoint) return `resumed:${resumeCheckpoint.step}`;
        reportCheckpoint?.({ step: 'chapter-2', data: { next: 3 }, updatedAt: 10 });
        await new Promise<void>((resolve) => {
          if (signal.aborted) {
            resolve();
            return;
          }
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'interrupted-run';
      }
    });

    await flush();
    expect(scheduler.status('resume-me')).toMatchObject({
      status: 'running',
      checkpoint: { step: 'chapter-2', data: { next: 3 }, updatedAt: 10 }
    });
    expect(events.map((event) => event.type)).toEqual(['created', 'queued', 'started', 'checkpointed']);

    expect(scheduler.interrupt('resume-me')).toBe(true);
    expect(scheduler.status('resume-me')).toMatchObject({
      status: 'interrupted',
      error: { name: 'TaskInterruptedError' },
      checkpoint: { step: 'chapter-2' }
    });
    expect(events.at(-1)?.type).toBe('interrupted');
    await expect(initial.promise).resolves.toBeUndefined();
    expect(scheduler.cancel('resume-me')).toBe(false);

    const resumed = scheduler.resume<string>('resume-me');
    expect(scheduler.status('resume-me').status).toBe('queued');
    await expect(resumed.promise).resolves.toBe('resumed:chapter-2');
    expect(runCount).toBe(2);
    expect(resumedFrom).toMatchObject({ step: 'chapter-2', data: { next: 3 }, updatedAt: 10 });
    expect(scheduler.status('resume-me').status).toBe('completed');
    expect(events.map((event) => event.type)).toEqual([
      'created',
      'queued',
      'started',
      'checkpointed',
      'interrupted',
      'queued',
      'started',
      'completed'
    ]);
    await scheduler.stop();
  });

  it('accepts an externally supplied checkpoint only when resuming an interrupted task', async () => {
    const scheduler = new TaskScheduler();
    let seenCheckpoint: ScheduledCheckpoint | undefined;
    const initial = scheduler.schedule({
      id: 'external-checkpoint',
      mode: 'background',
      debounceMs: 100,
      run: async (_signal, _reportProgress, _reportCheckpoint, resumeCheckpoint) => {
        seenCheckpoint = resumeCheckpoint;
        return 'done';
      }
    });

    expect(scheduler.checkpoint('external-checkpoint', { step: 'too-early' })).toBe(false);
    expect(scheduler.interrupt('external-checkpoint')).toBe(true);
    await expect(initial.promise).resolves.toBeUndefined();
    const resumed = scheduler.resume('external-checkpoint', { step: 'external-step', data: { offset: 4 } });
    await expect(resumed.promise).resolves.toBe('done');
    expect(seenCheckpoint).toMatchObject({ step: 'external-step', data: { offset: 4 } });
    await scheduler.stop();
  });

  it('interrupts active work during scheduler shutdown so its checkpoint can resume', async () => {
    const scheduler = new TaskScheduler();
    let resolveRun!: () => void;
    let sawAbort = false;
    const initial = scheduler.schedule({
      id: 'shutdown-interrupt',
      mode: 'foreground',
      run: async (signal, _reportProgress, reportCheckpoint) => {
        reportCheckpoint?.({ step: 'safe-point', data: { offset: 8 } });
        await new Promise<void>((resolve) => {
          resolveRun = resolve;
          signal.addEventListener(
            'abort',
            () => {
              sawAbort = true;
              resolve();
            },
            { once: true }
          );
        });
        return 'should-not-complete';
      }
    });

    await flush();
    await scheduler.stop();

    expect(sawAbort).toBe(true);
    expect(scheduler.status('shutdown-interrupt')).toMatchObject({
      status: 'interrupted',
      checkpoint: { step: 'safe-point', data: { offset: 8 } }
    });
    await expect(initial.promise).resolves.toBeUndefined();
    expect(() => scheduler.resume('shutdown-interrupt')).toThrow('Task scheduler is stopping');
    resolveRun();
  });

  it('pauses for user input, emits waiting_user, and resumes from the checkpoint', async () => {
    const scheduler = new TaskScheduler();
    const events: SchedulerEvent[] = [];
    scheduler.subscribe((event) => {
      events.push(event);
    });
    let runCount = 0;
    let resumedFrom: ScheduledCheckpoint | undefined;

    const initial = scheduler.schedule<string>({
      id: 'needs-user',
      mode: 'interactive',
      run: async (signal, _reportProgress, _reportCheckpoint, resumeCheckpoint) => {
        runCount += 1;
        resumedFrom = resumeCheckpoint;
        if (resumeCheckpoint) return `continued:${resumeCheckpoint.step}`;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return 'should-not-complete';
      }
    });

    await flush();
    expect(scheduler.checkpoint('needs-user', { step: 'approval', data: { chunk: 2 } })).toBe(true);
    expect(scheduler.waitForUser('needs-user')).toBe(true);
    expect(scheduler.status('needs-user')).toMatchObject({
      status: 'waiting-user',
      checkpoint: { step: 'approval', data: { chunk: 2 } }
    });
    expect(events.at(-1)?.type).toBe('waiting_user');
    await expect(initial.promise).resolves.toBeUndefined();

    const resumed = scheduler.resume<string>('needs-user');
    await expect(resumed.promise).resolves.toBe('continued:approval');
    expect(runCount).toBe(2);
    expect(resumedFrom).toMatchObject({ step: 'approval', data: { chunk: 2 } });
    expect(scheduler.status('needs-user').status).toBe('completed');
    await scheduler.stop();
  });
});
