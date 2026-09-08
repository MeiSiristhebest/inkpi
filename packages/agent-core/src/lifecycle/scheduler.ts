export type ScheduledMode = 'interactive' | 'foreground' | 'background' | 'batch';
export type ScheduledStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
export type LifecycleState = 'idle' | 'running' | 'stopping' | 'stopped';

export interface ScheduledWork<T> {
  id: string;
  mode: ScheduledMode;
  priority?: number;
  dedupeKey?: string;
  debounceMs?: number;
  timeoutMs?: number;
  maxAttempts?: number;
  retryDelayMs?: number;
  run(signal: AbortSignal, reportProgress?: (progress: number) => void): Promise<T>;
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
}

export interface SchedulerEvent {
  type: 'created' | 'queued' | 'started' | 'progress' | 'retrying' | 'completed' | 'failed' | 'cancelled';
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

  schedule<T>(work: ScheduledWork<T>): { promise: Promise<T | undefined>; cancel: () => boolean } {
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
      readyAt: this.now() + Math.max(0, work.debounceMs ?? 0)
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
    return { promise, cancel: () => this.cancel(work.id) };
  }

  cancel(id: string): boolean {
    const record = this.records.get(id);
    if (!record || isTerminal(record.snapshot.status)) return false;
    record.controller.abort();
    if (record.snapshot.status === 'queued' || record.snapshot.status === 'running') this.finishCancelled(record);
    return true;
  }

  status(id: string): ScheduledSnapshot {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown scheduled task: ${id}`);
    return { ...record.snapshot };
  }

  async stop(): Promise<void> {
    if (this.state === 'stopped') return;
    this.state = 'stopping';
    for (const record of this.records.values()) {
      if (!isTerminal(record.snapshot.status)) this.cancel(record.work.id);
    }
    await Promise.allSettled([...this.records.values()].map((record) => record.promise));
    this.state = 'stopped';
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
    record.snapshot.status = 'running';
    record.snapshot.startedAt = record.snapshot.startedAt ?? this.now();
    record.attempts += 1;
    record.snapshot.attempts = record.attempts;
    this.emit({ type: 'started', snapshot: this.status(record.work.id) });
    try {
      const operation = record.work.run(record.controller.signal, (progress) => {
        if (record.snapshot.status !== 'running') return;
        record.snapshot.progress = Math.max(0, Math.min(1, progress));
        this.emit({ type: 'progress', snapshot: this.status(record.work.id) });
      });
      const value = await this.withTimeout(record, operation);
      if (record.controller.signal.aborted) {
        this.finishCancelled(record);
        return;
      }
      record.snapshot.status = 'completed';
      record.snapshot.finishedAt = this.now();
      this.emit({ type: 'completed', snapshot: this.status(record.work.id) });
      record.resolve(value);
    } catch (error) {
      if (isRetryable(error) && record.attempts < Math.max(1, record.work.maxAttempts ?? 1)) {
        record.controller = new AbortController();
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
      } else if (record.controller.signal.aborted) {
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

  private async withTimeout<T>(record: ScheduledRecord<unknown>, operation: Promise<T>): Promise<T> {
    const timeoutMs = record.work.timeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return operation;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        record.controller.abort();
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
    if (isTerminal(record.snapshot.status)) return;
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
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isRetryable(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TaskTimeoutError' || (error as Error & { retryable?: boolean }).retryable === true)
  );
}
