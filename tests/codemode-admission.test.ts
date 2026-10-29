import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CODEMODE_WORKER_ADMISSION_LIMITS,
  CodemodeAdmissionQueue,
  CodemodeAdmissionQueueFullError,
  CodemodeAdmissionTimeoutError,
  createCodemodeWorkerReservation
} from '../packages/agent-core/src/codemode-admission.js';

afterEach(() => vi.useRealTimers());

describe('Codemode admission queue', () => {
  it('uses the internal shared-worker limits', () => {
    expect(CODEMODE_WORKER_ADMISSION_LIMITS).toEqual({
      maxActiveWorkers: 2,
      maxQueuedRequests: 8,
      maxWaitMs: 60_000
    });
  });

  it('grants permits in FIFO order without starving queued callers', async () => {
    let now = 0;
    const queue = new CodemodeAdmissionQueue({ capacity: 2, maxQueued: 2, subject: 'test worker', now: () => now });
    const releaseFirst = await queue.acquire();
    const releaseSecond = await queue.acquire();
    const grants: string[] = [];
    const third = (async () => {
      const release = await queue.acquire({ timeoutMs: 1_000 });
      grants.push('third');
      return release;
    })();
    const fourth = (async () => {
      const release = await queue.acquire({ timeoutMs: 1_000 });
      grants.push('fourth');
      return release;
    })();

    expect(queue.getSnapshot()).toMatchObject({ activeSlots: 2, queuedRequests: 2 });
    now = 5;
    releaseSecond();
    const releaseThird = await third;
    expect(grants).toEqual(['third']);
    expect(queue.getSnapshot()).toMatchObject({ activeSlots: 2, queuedRequests: 1 });

    now = 8;
    releaseFirst();
    const releaseFourth = await fourth;
    expect(grants).toEqual(['third', 'fourth']);
    releaseThird();
    releaseFourth();
    expect(queue.getSnapshot()).toMatchObject({
      activeSlots: 0,
      queuedRequests: 0,
      queueWaitCount: 2,
      queueWaitTotalMs: 13,
      queueWaitMaxMs: 8
    });
  });

  it('rejects beyond the bounded queue capacity', async () => {
    const queue = new CodemodeAdmissionQueue({ capacity: 1, maxQueued: 1, subject: 'test worker' });
    const release = await queue.acquire();
    const waiting = queue.acquire({ timeoutMs: 1_000 });

    await expect(queue.acquire({ timeoutMs: 1_000 })).rejects.toBeInstanceOf(CodemodeAdmissionQueueFullError);
    release();
    (await waiting)();
    expect(queue.getSnapshot()).toMatchObject({ activeSlots: 0, queuedRequests: 0 });
  });

  it('removes an aborted waiter and its timer so it cannot consume a later permit', async () => {
    vi.useFakeTimers();
    let now = 0;
    const queue = new CodemodeAdmissionQueue({ capacity: 1, maxQueued: 2, subject: 'test worker', now: () => now });
    const release = await queue.acquire();
    const controller = new AbortController();
    const cancelled = queue.acquire({ signal: controller.signal, timeoutMs: 1_000 });
    const next = queue.acquire({ timeoutMs: 1_000 });

    now = 7;
    controller.abort('session closed');
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError', message: 'session closed' });
    expect(queue.getSnapshot()).toMatchObject({
      activeSlots: 1,
      queuedRequests: 1,
      queueWaitCount: 1,
      queueWaitTotalMs: 7,
      queueWaitMaxMs: 7,
      cancelledRequests: 1,
      timedOutRequests: 0
    });
    expect(vi.getTimerCount()).toBe(1);

    release();
    (await next)();
    expect(queue.getSnapshot()).toMatchObject({ activeSlots: 0, queuedRequests: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out a waiter and cleans its queue entry and timer', async () => {
    vi.useFakeTimers();
    let now = 0;
    const queue = new CodemodeAdmissionQueue({ capacity: 1, maxQueued: 1, subject: 'test worker', now: () => now });
    const release = await queue.acquire();
    const waiting = queue.acquire({ timeoutMs: 25 });
    const rejected = expect(waiting).rejects.toBeInstanceOf(CodemodeAdmissionTimeoutError);

    now = 24;
    await vi.advanceTimersByTimeAsync(24);
    expect(queue.getSnapshot().queuedRequests).toBe(1);
    now = 25;
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(queue.getSnapshot()).toMatchObject({
      activeSlots: 1,
      queuedRequests: 0,
      queueWaitCount: 1,
      queueWaitTotalMs: 25,
      queueWaitMaxMs: 25,
      cancelledRequests: 0,
      timedOutRequests: 1
    });
    release();
    expect(queue.getSnapshot().activeSlots).toBe(0);
  });

  it('releases an untransferred reservation when cancellation or deadline wins startup', async () => {
    const cancelledQueue = new CodemodeAdmissionQueue({ capacity: 1, maxQueued: 1, subject: 'test worker' });
    const cancelController = new AbortController();
    const cancelledReservation = createCodemodeWorkerReservation({
      release: await cancelledQueue.acquire(),
      signal: cancelController.signal,
      remainingMs: () => 1_000,
      executionSettled: () => false
    });
    cancelController.abort('cancel before worker start');
    expect(() => cancelledReservation.acquireWorker()).toThrow('cancel before worker start');
    cancelledReservation.releaseIfUntransferred();
    expect(cancelledQueue.getSnapshot().activeSlots).toBe(0);

    const deadlineQueue = new CodemodeAdmissionQueue({ capacity: 1, maxQueued: 1, subject: 'test worker' });
    const deadlineReservation = createCodemodeWorkerReservation({
      release: await deadlineQueue.acquire(),
      remainingMs: () => 0,
      executionSettled: () => false
    });
    expect(() => deadlineReservation.acquireWorker()).toThrow('deadline expired');
    deadlineReservation.releaseIfUntransferred();
    expect(deadlineQueue.getSnapshot().activeSlots).toBe(0);
  });

  it('holds a transferred slot after result settlement until the actual worker-exit release', async () => {
    const queue = new CodemodeAdmissionQueue({ capacity: 1, maxQueued: 1, subject: 'test worker' });
    let executionSettled = false;
    const reservation = createCodemodeWorkerReservation({
      release: await queue.acquire(),
      remainingMs: () => 1_000,
      executionSettled: () => executionSettled
    });
    const releaseOnWorkerExit = reservation.acquireWorker();
    expect(reservation.wasTransferred()).toBe(true);
    let resolveWorkerExit!: () => void;
    const workerExited = new Promise<void>((resolve) => {
      resolveWorkerExit = resolve;
    });
    void (async () => {
      try {
        await workerExited;
      } finally {
        releaseOnWorkerExit();
      }
    })();

    await expect(Promise.resolve('result settled')).resolves.toBe('result settled');
    executionSettled = true;
    reservation.releaseIfUntransferred();
    expect(() => reservation.acquireWorker()).toThrow('settled before worker startup');
    let nextAdmitted = false;
    const waiting = queue.acquire({ timeoutMs: 1_000 });
    const admitted = (async () => {
      const release = await waiting;
      nextAdmitted = true;
      return release;
    })();
    await Promise.resolve();
    expect(queue.getSnapshot()).toMatchObject({ activeSlots: 1, queuedRequests: 1 });
    expect(nextAdmitted).toBe(false);

    resolveWorkerExit();
    const releaseNext = await admitted;
    expect(nextAdmitted).toBe(true);
    expect(queue.getSnapshot()).toMatchObject({ activeSlots: 1, queuedRequests: 0 });
    releaseOnWorkerExit();
    expect(queue.getSnapshot().activeSlots).toBe(1);
    releaseNext();
    expect(queue.getSnapshot().activeSlots).toBe(0);
  });
});
