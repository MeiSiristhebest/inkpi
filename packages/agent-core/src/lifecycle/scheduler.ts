export type ScheduledMode = 'interactive' | 'foreground' | 'background' | 'batch';
export type ScheduledStatus =
  | 'queued'
  | 'running'
  | 'waiting-user'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';
export type LifecycleState = 'idle' | 'running' | 'stopping' | 'stopped';

export interface ScheduledCheckpoint {
  step: string;
  data?: unknown;
  updatedAt?: number;
}

export interface ScheduledHandle<T> {
  promise: Promise<T | undefined>;
  cancel: () => boolean;
}

export interface ScheduledWork<T> {
  id: string;
  mode: ScheduledMode;
  priority?: number;
  dedupeKey?: string;
  debounceMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  run(
    signal: AbortSignal,
    reportProgress?: (progress: number) => void,
    reportCheckpoint?: (checkpoint: ScheduledCheckpoint) => void,
    resumeFrom?: ScheduledCheckpoint
  ): Promise<T>;
}

export interface ScheduledSnapshot {
  id: string;
  mode: ScheduledMode;
  status: ScheduledStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: Error;
  progress?: number;
  attempts?: number;
  checkpoint?: ScheduledCheckpoint;
}

export interface SchedulerEvent {
  type:
    | 'created'
    | 'queued'
    | 'started'
    | 'progress'
    | 'retrying'
    | 'checkpointed'
    | 'waiting_user'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  snapshot: ScheduledSnapshot;
}

export interface TaskSchedulerOptions {
  maxForeground?: number;
  maxBackground?: number;
  now?: () => number;
}

interface ScheduledRecord<T> {
  work: ScheduledWork<T>;
  controller: AbortController;
  snapshot: ScheduledSnapshot;
  promise: Promise<T | undefined>;
  resolve: (value: T | undefined) => void;
  reject: (error: unknown) => void;
  attempts: number;
  readyAt: number;
  readyTimer?: ReturnType<typeof setTimeout>;
  generation: number;
  resumeFrom?: ScheduledCheckpoint;
}

export class TaskScheduler {
  private readonly records = new Map<string, ScheduledRecord<unknown>>();
  private readonly maxForeground: number;
  private readonly maxBackground: number;
  private readonly now: () => number;
  private readonly listeners = new Set<(event: SchedulerEvent) => void | Promise<void>>();
  private state: LifecycleState = 'idle';

  constructor(options: TaskSchedulerOptions = {}) {
    this.maxForeground = Math.max(1, options.maxForeground ?? 1);
    this.maxBackground = Math.max(1, options.maxBackground ?? 2);
    this.now = options.now ?? Date.now;
  }

  lifecycle(): LifecycleState {
    return this.state;
  }

  subscribe(listener: (event: SchedulerEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    if (this.state === 'stopped') throw new Error('Task scheduler cannot restart after it stops');
    this.state = 'running';
    this.pump();
  }

  schedule<T>(work: ScheduledWork<T>): ScheduledHandle<T> {
    if (this.state === 'stopping' || this.state === 'stopped') throw new Error('Task scheduler is stopping');
    if (!work.id.trim()) throw new Error(`Scheduled task id is unavailable: ${work.id}`);
    const duplicate = work.dedupeKey
      ? [...this.records.values()].find(
          (record) => record.work.dedupeKey === work.dedupeKey && !isTerminal(record.snapshot.status)
        )
      : undefined;
    if (duplicate) {
      return {
        promise: duplicate.promise as Promise<T | undefined>,
        cancel: () => this.cancel(duplicate.work.id)
      };
    }
    if (this.records.has(work.id)) throw new Error(`Scheduled task id is unavailable: ${work.id}`);
    if (this.state === 'idle') this.state = 'running';
    let resolve!: (value: T | undefined) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T | undefined>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const record: ScheduledRecord<unknown> = {
      work,
      controller: new AbortController(),
      snapshot: { id: work.id, mode: work.mode, status: 'queued' },
      promise,
      resolve: resolve as (value: unknown) => void,
      reject,
      attempts: 0,
      readyAt: this.now() + Math.max(0, work.debounceMs ?? 0),
      generation: 0
    };
    this.records.set(work.id, record);
    this.emit({ type: 'created', snapshot: this.status(work.id) });
    this.emit({ type: 'queued', snapshot: this.status(work.id) });
    if (record.readyAt > this.now()) {
      record.readyTimer = setTimeout(() => {
        record.readyTimer = undefined;
        this.pump();
      }, record.readyAt - this.now());
    }
    queueMicrotask(() => this.pump());
    return this.handle<T>(record);
  }

  cancel(id: string): boolean {
    const record = this.records.get(id);
    if (!record || isTerminal(record.snapshot.status) || record.snapshot.status === 'interrupted') return false;
    record.generation += 1;
    record.controller.abort();
    if (record.snapshot.status === 'queued' || record.snapshot.status === 'running') this.finishCancelled(record);
    return true;
  }

  /** Records a resumable checkpoint for a running task. */
  checkpoint(id: string, checkpoint: ScheduledCheckpoint): boolean {
    const record = this.records.get(id);
    if (!record || record.snapshot.status !== 'running') return false;
    return this.recordCheckpoint(record, checkpoint, record.generation);
  }

  /**
   * Pauses a running task for human input while retaining its checkpoint.
   * The current handle resolves with undefined; resume() returns a new handle
   * for the continued execution.
   */
  waitForUser(id: string, checkpoint?: ScheduledCheckpoint): boolean {
    const record = this.records.get(id);
    if (!record || record.snapshot.status !== 'running') return false;
    if (checkpoint && !this.recordCheckpoint(record, checkpoint, record.generation)) return false;
    if (!record.snapshot.checkpoint) return false;
    record.generation += 1;
    record.controller.abort();
    record.snapshot.status = 'waiting-user';
    record.snapshot.error = undefined;
    record.snapshot.finishedAt = this.now();
    this.emit({ type: 'waiting_user', snapshot: this.status(id) });
    record.resolve(undefined);
    this.pump();
    return true;
  }

  /** Interrupts a task without treating it as a user cancellation. */
  interrupt(id: string): boolean {
    const record = this.records.get(id);
    if (!record || isTerminal(record.snapshot.status) || record.snapshot.status === 'interrupted') return false;
    record.generation += 1;
    record.controller.abort();
    if (record.readyTimer) {
      clearTimeout(record.readyTimer);
      record.readyTimer = undefined;
    }
    const resolveInterrupted = record.resolve;
    record.snapshot.status = 'interrupted';
    record.snapshot.error = interruptedError();
    record.snapshot.finishedAt = this.now();
    this.emit({ type: 'interrupted', snapshot: this.status(id) });
    resolveInterrupted(undefined);
    this.pump();
    return true;
  }

  /**
   * Requeues an interrupted task and passes its last (or supplied) checkpoint
   * to the fourth, optional run() argument.
   */
  resume<T = unknown>(id: string, checkpoint?: ScheduledCheckpoint): ScheduledHandle<T> {
    if (this.state === 'stopping' || this.state === 'stopped') throw new Error('Task scheduler is stopping');
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown scheduled task: ${id}`);
    if (record.snapshot.status !== 'interrupted' && record.snapshot.status !== 'waiting-user') {
      throw new Error(`Scheduled task cannot resume from ${record.snapshot.status}`);
    }
    if (record.snapshot.status === 'waiting-user' && !record.snapshot.checkpoint) {
      throw new Error(`Scheduled task ${id} has no checkpoint to resume`);
    }
    if (checkpoint) {
      const normalized = normalizeCheckpoint(checkpoint, this.now);
      if (!normalized) throw new Error('Scheduled task checkpoint step is unavailable');
      record.snapshot.checkpoint = normalized;
    }
    if (record.readyTimer) {
      clearTimeout(record.readyTimer);
      record.readyTimer = undefined;
    }
    record.generation += 1;
    record.controller = new AbortController();
    record.resumeFrom = record.snapshot.checkpoint ? cloneCheckpoint(record.snapshot.checkpoint) : undefined;
    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    record.promise = promise;
    record.resolve = resolve;
    record.reject = reject;
    record.snapshot.status = 'queued';
    record.snapshot.startedAt = undefined;
    record.snapshot.finishedAt = undefined;
    record.snapshot.error = undefined;
    record.readyAt = this.now();
    if (this.state === 'idle') this.state = 'running';
    this.emit({ type: 'queued', snapshot: this.status(id) });
    queueMicrotask(() => this.pump());
    return this.handle(record) as ScheduledHandle<T>;
  }

  status(id: string): ScheduledSnapshot {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown scheduled task: ${id}`);
    const snapshot = { ...record.snapshot };
    if (record.snapshot.checkpoint) snapshot.checkpoint = cloneCheckpoint(record.snapshot.checkpoint);
    return snapshot;
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopping';
    for (const record of this.records.values()) {
      if (!isTerminal(record.snapshot.status) && record.snapshot.status !== 'interrupted') {
        this.interrupt(record.work.id);
      }
    }
    await Promise.allSettled([...this.records.values()].map((record) => record.promise));
    this.state = 'stopped';
  }

  private handle<T>(record: ScheduledRecord<unknown>): ScheduledHandle<T> {
    return {
      promise: record.promise as Promise<T | undefined>,
      cancel: () => this.cancel(record.work.id)
    };
  }

  private pump(): void {
    if (this.state === 'stopping' || this.state === 'stopped') return;
    let runningForeground = this.runningCount('interactive') + this.runningCount('foreground');
    let runningBackground = this.runningCount('background') + this.runningCount('batch');
    const available = [...this.records.values()]
      .filter((record) => record.snapshot.status === 'queued' && record.readyAt <= this.now())
      .sort(
        (left, right) =>
          (right.work.priority ?? 0) - (left.work.priority ?? 0) || left.work.id.localeCompare(right.work.id)
      );
    for (const record of available) {
      const foreground = record.work.mode === 'interactive' || record.work.mode === 'foreground';
      const canStart = foreground ? runningForeground < this.maxForeground : runningBackground < this.maxBackground;
      if (!canStart) continue;
      if (foreground) runningForeground += 1;
      else runningBackground += 1;
      void this.execute(record);
    }
  }

  private runningCount(mode: ScheduledMode): number {
    return [...this.records.values()].filter(
      (record) => record.snapshot.status === 'running' && record.work.mode === mode
    ).length;
  }

  private async execute(record: ScheduledRecord<unknown>): Promise<void> {
    if (record.snapshot.status !== 'queued' || record.controller.signal.aborted) return;
    const generation = record.generation;
    const controller = record.controller;
    const resumeFrom = record.resumeFrom;
    record.resumeFrom = undefined;
    record.snapshot.status = 'running';
    record.snapshot.startedAt = record.snapshot.startedAt ?? this.now();
    record.attempts += 1;
    record.snapshot.attempts = record.attempts;
    this.emit({ type: 'started', snapshot: this.status(record.work.id) });
    try {
      const operation = record.work.run(
        controller.signal,
        (progress) => {
          if (!this.isCurrent(record, generation) || record.snapshot.status !== 'running') return;
          record.snapshot.progress = Math.max(0, Math.min(1, progress));
          this.emit({ type: 'progress', snapshot: this.status(record.work.id) });
        },
        (checkpoint) => {
          this.recordCheckpoint(record, checkpoint, generation);
        },
        resumeFrom
      );
      const value = await this.withTimeout(record, controller, operation);
      if (!this.isCurrent(record, generation)) return;
      if (controller.signal.aborted) {
        this.finishCancelled(record);
        return;
      }
      record.snapshot.status = 'completed';
      record.snapshot.finishedAt = this.now();
      this.emit({ type: 'completed', snapshot: this.status(record.work.id) });
      record.resolve(value);
    } catch (error) {
      if (!this.isCurrent(record, generation)) return;
      if (isRetryable(error) && record.attempts < Math.max(1, record.work.maxAttempts ?? 1)) {
        record.controller = new AbortController();
        record.generation += 1;
        record.snapshot.status = 'queued';
        record.readyAt = Number.MAX_SAFE_INTEGER;
        this.emit({ type: 'retrying', snapshot: this.status(record.work.id) });
        const schedule = () => {
          if (record.snapshot.status !== 'queued') return;
          record.readyAt = this.now();
          this.pump();
        };
        const delay = Math.max(0, record.work.retryDelayMs ?? 0);
        if (delay > 0) setTimeout(schedule, delay);
        else queueMicrotask(schedule);
      } else if (controller.signal.aborted) {
        this.finishCancelled(record);
      } else {
        record.snapshot.status = 'failed';
        record.snapshot.error = error instanceof Error ? error : new Error(String(error));
        record.snapshot.finishedAt = this.now();
        this.emit({ type: 'failed', snapshot: this.status(record.work.id) });
        record.reject(error);
      }
    } finally {
      this.pump();
    }
  }

  private isCurrent(record: ScheduledRecord<unknown>, generation: number): boolean {
    return record.generation === generation;
  }

  private recordCheckpoint(
    record: ScheduledRecord<unknown>,
    checkpoint: ScheduledCheckpoint,
    generation: number
  ): boolean {
    if (!this.isCurrent(record, generation) || record.snapshot.status !== 'running') return false;
    const normalized = normalizeCheckpoint(checkpoint, this.now);
    if (!normalized) return false;
    record.snapshot.checkpoint = normalized;
    this.emit({ type: 'checkpointed', snapshot: this.status(record.work.id) });
    return true;
  }

  private async withTimeout<T>(
    record: ScheduledRecord<unknown>,
    controller: AbortController,
    operation: Promise<T>
  ): Promise<T> {
    const timeoutMs = record.work.timeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return operation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        const error = new Error(`Scheduled task exceeded its timeout of ${timeoutMs}ms`);
        error.name = 'TaskTimeoutError';
        (error as Error & { retryable?: boolean }).retryable = true;
        reject(error);
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
      void operation.catch(() => undefined);
    }
  }

  private finishCancelled(record: ScheduledRecord<unknown>): void {
    if (isTerminal(record.snapshot.status) || record.snapshot.status === 'interrupted') return;
    if (record.readyTimer) clearTimeout(record.readyTimer);
    record.snapshot.status = 'cancelled';
    record.snapshot.finishedAt = this.now();
    this.emit({ type: 'cancelled', snapshot: this.status(record.work.id) });
    record.resolve(undefined);
    this.pump();
  }

  private emit(event: SchedulerEvent): void {
    for (const listener of this.listeners) void listener(event);
  }
}

function isTerminal(status: ScheduledStatus): boolean {
  return status === 'waiting-user' || status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TaskTimeoutError' || (error as Error & { retryable?: boolean }).retryable === true)
  );
}

function normalizeCheckpoint(checkpoint: ScheduledCheckpoint, now: () => number): ScheduledCheckpoint | undefined {
  if (!checkpoint || typeof checkpoint.step !== 'string' || !checkpoint.step.trim()) return undefined;
  return {
    step: checkpoint.step,
    data: cloneValue(checkpoint.data),
    updatedAt: checkpoint.updatedAt ?? now()
  };
}

function cloneCheckpoint(checkpoint: ScheduledCheckpoint): ScheduledCheckpoint {
  return {
    ...checkpoint,
    data: cloneValue(checkpoint.data)
  };
}

function interruptedError(): Error {
  const error = new Error('Scheduled task was interrupted; resume it to continue');
  error.name = 'TaskInterruptedError';
  return error;
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}
