export type CodemodeAdmissionRelease = () => void;

export interface CodemodeAdmissionOptions {
  readonly capacity: number;
  readonly maxQueued: number;
  readonly subject: string;
  readonly now?: () => number;
}

export interface CodemodeAdmissionRequest {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface CodemodeAdmissionSnapshot {
  readonly activeSlots: number;
  readonly queuedRequests: number;
  readonly capacity: number;
  readonly maxQueued: number;
  readonly queueWaitCount: number;
  readonly queueWaitTotalMs: number;
  readonly queueWaitMaxMs: number;
  readonly cancelledRequests: number;
  readonly timedOutRequests: number;
}

interface Waiter {
  readonly resolve: (release: CodemodeAdmissionRelease) => void;
  readonly reject: (error: Error) => void;
  readonly cleanup: () => void;
  readonly queuedAt: number;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
  settled: boolean;
}

export class CodemodeAdmissionQueueFullError extends Error {
  constructor(subject: string, maxQueued: number) {
    super(`${subject} queue is full; at most ${maxQueued} requests may wait.`);
    this.name = 'CodemodeAdmissionQueueFullError';
  }
}

export class CodemodeAdmissionTimeoutError extends Error {
  constructor(subject: string, timeoutMs: number) {
    super(`${subject} admission wait timed out after ${Math.ceil(timeoutMs)} ms.`);
    this.name = 'CodemodeAdmissionTimeoutError';
  }
}

/** A bounded FIFO permit queue. Each permit's release function is idempotent. */
export class CodemodeAdmissionQueue {
  private activeSlots = 0;
  private queueWaitCount = 0;
  private queueWaitTotalMs = 0;
  private queueWaitMaxMs = 0;
  private cancelledRequests = 0;
  private timedOutRequests = 0;
  private readonly waiters: Waiter[] = [];
  private readonly now: () => number;

  constructor(private readonly options: CodemodeAdmissionOptions) {
    this.now = options.now ?? (() => performance.now());
    if (!Number.isInteger(options.capacity) || options.capacity < 1) {
      throw new RangeError('Codemode admission capacity must be a positive integer.');
    }
    if (!Number.isInteger(options.maxQueued) || options.maxQueued < 0) {
      throw new RangeError('Codemode admission queue capacity must be a non-negative integer.');
    }
    if (!options.subject.trim()) throw new Error('Codemode admission subject must not be empty.');
  }

  public acquire(request: CodemodeAdmissionRequest = {}): Promise<CodemodeAdmissionRelease> {
    const { signal, timeoutMs } = request;
    if (signal?.aborted) {
      this.cancelledRequests += 1;
      return Promise.reject(createCodemodeAbortError(signal.reason));
    }
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      this.timedOutRequests += 1;
      return Promise.reject(new CodemodeAdmissionTimeoutError(this.options.subject, Math.max(0, timeoutMs)));
    }

    if (this.activeSlots < this.options.capacity && this.waiters.length === 0) {
      this.activeSlots += 1;
      return Promise.resolve(this.createRelease());
    }
    if (this.waiters.length >= this.options.maxQueued) {
      return Promise.reject(new CodemodeAdmissionQueueFullError(this.options.subject, this.options.maxQueued));
    }

    return new Promise<CodemodeAdmissionRelease>((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        signal,
        queuedAt: this.now(),
        settled: false,
        cleanup: () => {
          if (waiter.timer !== undefined) clearTimeout(waiter.timer);
          if (signal && waiter.onAbort) signal.removeEventListener('abort', waiter.onAbort);
        }
      };
      this.waiters.push(waiter);

      if (signal) {
        waiter.onAbort = () => this.cancel(waiter, createCodemodeAbortError(signal.reason), 'cancelled');
        signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      if (timeoutMs !== undefined) {
        waiter.timer = setTimeout(
          () => this.cancel(waiter, new CodemodeAdmissionTimeoutError(this.options.subject, timeoutMs), 'timedOut'),
          timeoutMs
        );
      }
      if (signal?.aborted) waiter.onAbort?.();
    });
  }

  public getSnapshot(): CodemodeAdmissionSnapshot {
    return {
      activeSlots: this.activeSlots,
      queuedRequests: this.waiters.length,
      capacity: this.options.capacity,
      maxQueued: this.options.maxQueued,
      queueWaitCount: this.queueWaitCount,
      queueWaitTotalMs: this.queueWaitTotalMs,
      queueWaitMaxMs: this.queueWaitMaxMs,
      cancelledRequests: this.cancelledRequests,
      timedOutRequests: this.timedOutRequests
    };
  }

  private createRelease(): CodemodeAdmissionRelease {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  private releaseSlot(): void {
    const next = this.waiters.shift();
    if (next) {
      next.settled = true;
      next.cleanup();
      this.recordWait(next);
      next.resolve(this.createRelease());
      return;
    }
    this.activeSlots -= 1;
  }

  private cancel(waiter: Waiter, error: Error, outcome: 'cancelled' | 'timedOut'): void {
    if (waiter.settled) return;
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    waiter.settled = true;
    waiter.cleanup();
    this.recordWait(waiter);
    if (outcome === 'cancelled') this.cancelledRequests += 1;
    else this.timedOutRequests += 1;
    waiter.reject(error);
  }

  private recordWait(waiter: Waiter): void {
    const elapsed = this.now() - waiter.queuedAt;
    const waitMs = Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
    this.queueWaitCount += 1;
    this.queueWaitTotalMs += waitMs;
    this.queueWaitMaxMs = Math.max(this.queueWaitMaxMs, waitMs);
  }
}

export interface CodemodeWorkerReservationOptions {
  readonly release: CodemodeAdmissionRelease;
  readonly signal?: AbortSignal;
  readonly remainingMs: () => number;
  readonly executionSettled: () => boolean;
}

export interface CodemodeWorkerReservation {
  readonly acquireWorker: () => CodemodeAdmissionRelease;
  readonly wasTransferred: () => boolean;
  readonly releaseIfUntransferred: () => void;
}

/** Transfers an admitted slot to pi-codemode only while the execution can still start a worker. */
export function createCodemodeWorkerReservation(options: CodemodeWorkerReservationOptions): CodemodeWorkerReservation {
  let transferred = false;
  let finalized = false;
  return {
    acquireWorker: () => {
      if (finalized || options.executionSettled()) {
        throw new Error('Codemode execution settled before worker startup.');
      }
      if (options.signal?.aborted) throw createCodemodeAbortError(options.signal.reason);
      if (options.remainingMs() <= 0) throw new Error('Codemode script deadline expired before worker startup.');
      if (transferred) throw new Error('Codemode worker admission lease was transferred twice.');
      transferred = true;
      return options.release;
    },
    wasTransferred: () => transferred,
    releaseIfUntransferred: () => {
      if (finalized) return;
      finalized = true;
      if (!transferred) options.release();
    }
  };
}

export const CODEMODE_WORKER_ADMISSION_LIMITS = Object.freeze({
  maxActiveWorkers: 2,
  maxQueuedRequests: 8,
  maxWaitMs: 60_000
});

const sharedCodemodeWorkerAdmission = new CodemodeAdmissionQueue({
  capacity: CODEMODE_WORKER_ADMISSION_LIMITS.maxActiveWorkers,
  maxQueued: CODEMODE_WORKER_ADMISSION_LIMITS.maxQueuedRequests,
  subject: 'Codemode worker'
});

export function acquireCodemodeWorkerSlot(
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<CodemodeAdmissionRelease> {
  return sharedCodemodeWorkerAdmission.acquire({ signal, timeoutMs });
}

export function getCodemodeWorkerAdmissionSnapshot(): CodemodeAdmissionSnapshot {
  return sharedCodemodeWorkerAdmission.getSnapshot();
}

export function createCodemodeAbortError(reason: unknown): Error {
  if (reason instanceof Error) return reason;
  const error = new Error(typeof reason === 'string' && reason ? reason : 'Codemode admission was aborted.');
  error.name = 'AbortError';
  return error;
}
