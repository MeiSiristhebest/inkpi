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

export interface ScheduledTaskState {
  id: string;
  mode: ScheduledMode;
  status: ScheduledStatus;
  snapshot: ScheduledSnapshot;
  attempts: number;
  readyAt: number;
}

export interface TaskSchedulerPersistence {
  load(id: string): ScheduledTaskState | undefined | Promise<ScheduledTaskState | undefined>;
  /** Enumerate persisted schedules so a new scheduler can recover its queue. */
  list?(): ScheduledTaskState[] | Promise<ScheduledTaskState[]>;
  save(state: ScheduledTaskState): void | Promise<void>;
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
  persistence?: TaskSchedulerPersistence;
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
  priority: number;
  sequence: number;
  dedupeKey?: string;
  slotAcquired: boolean;
  generation: number;
  resumeFrom?: ScheduledCheckpoint;
}

class ScheduledPriorityQueue {
  private readonly entries: ScheduledRecord<unknown>[] = [];
  private readonly positions = new Map<string, number>();

  constructor(private readonly compare: (left: ScheduledRecord<unknown>, right: ScheduledRecord<unknown>) => number) {}

  peek(): ScheduledRecord<unknown> | undefined {
    return this.entries[0];
  }

  push(record: ScheduledRecord<unknown>): void {
    if (this.positions.has(record.work.id)) return;
    const index = this.entries.length;
    this.entries.push(record);
    this.positions.set(record.work.id, index);
    this.siftUp(index);
  }

  pop(): ScheduledRecord<unknown> | undefined {
    return this.removeAt(0);
  }

  remove(id: string): boolean {
    const index = this.positions.get(id);
    if (index === undefined) return false;
    this.removeAt(index);
    return true;
  }

  private removeAt(index: number): ScheduledRecord<unknown> | undefined {
    if (index < 0 || index >= this.entries.length) return undefined;
    const removed = this.entries[index]!;
    const last = this.entries.pop()!;
    this.positions.delete(removed.work.id);
    if (index < this.entries.length) {
      this.entries[index] = last;
      this.positions.set(last.work.id, index);
      if (index > 0 && this.compare(this.entries[index]!, this.entries[parentIndex(index)]!) < 0) {
        this.siftUp(index);
      } else {
        this.siftDown(index);
      }
    }
    return removed;
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = parentIndex(index);
      if (this.compare(this.entries[index]!, this.entries[parent]!) >= 0) return;
      this.swap(index, parent);
      index = parent;
    }
  }

  private siftDown(start: number): void {
    let index = start;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let first = index;
      if (left < this.entries.length && this.compare(this.entries[left]!, this.entries[first]!) < 0) {
        first = left;
      }
      if (right < this.entries.length && this.compare(this.entries[right]!, this.entries[first]!) < 0) {
        first = right;
      }
      if (first === index) return;
      this.swap(index, first);
      index = first;
    }
  }

  private swap(left: number, right: number): void {
    const leftEntry = this.entries[left]!;
    const rightEntry = this.entries[right]!;
    this.entries[left] = rightEntry;
    this.entries[right] = leftEntry;
    this.positions.set(leftEntry.work.id, right);
    this.positions.set(rightEntry.work.id, left);
  }
}

export class TaskScheduler {
  private readonly records = new Map<string, ScheduledRecord<unknown>>();
  private readonly foregroundReady = new ScheduledPriorityQueue(compareScheduledRecords);
  private readonly backgroundReady = new ScheduledPriorityQueue(compareScheduledRecords);
  private readonly delayedReady = new ScheduledPriorityQueue(compareReadyRecords);
  private readonly dedupeIndex = new Map<string, Set<ScheduledRecord<unknown>>>();
  private readonly maxForeground: number;
  private readonly maxBackground: number;
  private readonly now: () => number;
  private readonly persistence?: TaskSchedulerPersistence;
  private readonly listeners = new Set<(event: SchedulerEvent) => void | Promise<void>>();
  private persistenceTail: Promise<void> = Promise.resolve();
  private state: LifecycleState = 'idle';
  private nextSequence = 0;
  private runningForeground = 0;
  private runningBackground = 0;
  private readyTimer?: { readyAt: number; handle: ReturnType<typeof setTimeout> };
  private pumpScheduled = false;

  constructor(options: TaskSchedulerOptions = {}) {
    this.maxForeground = Math.max(1, options.maxForeground ?? 1);
    this.maxBackground = Math.max(1, options.maxBackground ?? 2);
    this.now = options.now ?? Date.now;
    this.persistence = options.persistence;
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
    const duplicate = this.findDuplicate(work.dedupeKey);
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
      priority: normalizePriority(work.priority),
      sequence: this.nextSequence++,
      dedupeKey: work.dedupeKey,
      slotAcquired: false,
      generation: 0
    };
    this.records.set(work.id, record);
    this.registerDedupe(record);
    this.persist(record);
    this.emit({ type: 'created', snapshot: this.status(work.id) });
    this.emit({ type: 'queued', snapshot: this.status(work.id) });
    this.arm(record);
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
    const resolveWaiting = record.resolve;
    this.releaseSlot(record);
    this.releaseDedupe(record);
    record.snapshot.status = 'waiting-user';
    record.snapshot.error = undefined;
    record.snapshot.finishedAt = this.now();
    this.persist(record);
    this.emit({ type: 'waiting_user', snapshot: this.status(id) });
    resolveWaiting(undefined);
    this.pump();
    return true;
  }

  /** Interrupts a task without treating it as a user cancellation. */
  interrupt(id: string): boolean {
    const record = this.records.get(id);
    if (!record || isTerminal(record.snapshot.status) || record.snapshot.status === 'interrupted') return false;
    record.generation += 1;
    record.controller.abort();
    this.removeReady(record);
    this.releaseSlot(record);
    const resolveInterrupted = record.resolve;
    record.snapshot.status = 'interrupted';
    record.snapshot.error = interruptedError();
    record.snapshot.finishedAt = this.now();
    this.persist(record);
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
    this.registerDedupe(record);
    record.snapshot.startedAt = undefined;
    record.snapshot.finishedAt = undefined;
    record.snapshot.error = undefined;
    record.readyAt = this.now();
    if (this.state === 'idle') this.state = 'running';
    this.persist(record);
    this.emit({ type: 'queued', snapshot: this.status(id) });
    this.arm(record);
    return this.handle(record) as ScheduledHandle<T>;
  }

  /** Rehydrates one recoverable task from the configured persistence boundary. */
  async rehydrate<T>(work: ScheduledWork<T>): Promise<ScheduledHandle<T> | undefined> {
    const persistence = this.persistence;
    if (!persistence) throw new Error('Task scheduler persistence is not configured');
    if (this.state === 'stopping' || this.state === 'stopped') throw new Error('Task scheduler is stopping');
    if (!work.id.trim()) throw new Error(`Scheduled task id is unavailable: ${work.id}`);
    if (this.records.has(work.id)) throw new Error(`Scheduled task id is unavailable: ${work.id}`);

    const stored = await persistence.load(work.id);
    if (!stored) return undefined;
    if (stored.id !== work.id || stored.snapshot.id !== work.id) {
      throw new Error(`Persisted scheduled task does not match: ${work.id}`);
    }
    if (stored.mode !== work.mode || stored.snapshot.mode !== work.mode) {
      throw new Error(`Persisted scheduled task mode does not match: ${work.id}`);
    }
    if (stored.status === 'completed' || stored.status === 'failed' || stored.status === 'cancelled') {
      return undefined;
    }

    const snapshot = cloneSnapshot(stored.snapshot);
    snapshot.status = stored.status;
    let interruptedOnRecovery = false;
    if (stored.status === 'running') {
      snapshot.status = 'interrupted';
      snapshot.error = interruptedError('Scheduled task was interrupted before scheduler recovery');
      snapshot.finishedAt = this.now();
      interruptedOnRecovery = true;
    }

    let resolve!: (value: unknown | undefined) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<unknown | undefined>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    if (snapshot.status === 'interrupted' || snapshot.status === 'waiting-user') resolve(undefined);
    const record: ScheduledRecord<unknown> = {
      work,
      controller: new AbortController(),
      snapshot,
      promise,
      resolve: resolve as (value: unknown) => void,
      reject,
      attempts: Math.max(0, stored.attempts),
      readyAt: Number.isFinite(stored.readyAt) ? stored.readyAt : this.now(),
      priority: normalizePriority(work.priority),
      sequence: this.nextSequence++,
      dedupeKey: work.dedupeKey,
      slotAcquired: false,
      generation: 0
    };
    // A queued record may have been persisted after reaching a checkpoint
    // (for example while waiting for a retry delay). Preserve that checkpoint
    // when the scheduler is rebuilt so the first post-restart attempt resumes
    // from the durable boundary instead of starting from the beginning.
    if (snapshot.status === 'queued' && snapshot.checkpoint) {
      record.resumeFrom = cloneCheckpoint(snapshot.checkpoint);
    }
    record.snapshot.attempts ??= record.attempts;
    this.records.set(work.id, record);
    this.registerDedupe(record);
    if (this.state === 'idle') this.state = 'running';
    if (snapshot.status === 'queued') {
      this.emit({ type: 'queued', snapshot: this.status(work.id) });
      this.arm(record);
    } else if (interruptedOnRecovery) {
      this.persist(record);
    }
    return this.handle<T>(record);
  }

  /**
   * Rehydrates every non-terminal schedule exposed by the persistence boundary.
   * The resolver supplies executable work because functions are intentionally
   * never serialized with the durable schedule metadata.
   */
  async rehydrateAll(
    resolveWork: (
      state: ScheduledTaskState
    ) => ScheduledWork<unknown> | undefined | Promise<ScheduledWork<unknown> | undefined>
  ): Promise<ScheduledHandle<unknown>[]> {
    const persistence = this.persistence;
    if (!persistence) throw new Error('Task scheduler persistence is not configured');
    if (!persistence.list) throw new Error('Task scheduler persistence does not support listing schedules');
    if (this.state === 'stopping' || this.state === 'stopped') throw new Error('Task scheduler is stopping');

    const states = await persistence.list();
    const handles: ScheduledHandle<unknown>[] = [];
    for (const state of states) {
      if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') continue;
      const work = await resolveWork(cloneScheduledState(state));
      if (!work) continue;
      if (work.id !== state.id) {
        throw new Error(`Resolved scheduled task id does not match persisted state: ${state.id}`);
      }
      const handle = await this.rehydrate(work);
      if (handle) handles.push(handle);
    }
    return handles;
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
    await this.flush();
    this.state = 'stopped';
  }

  async flush(): Promise<void> {
    await this.persistenceTail;
  }

  private handle<T>(record: ScheduledRecord<unknown>): ScheduledHandle<T> {
    return {
      promise: record.promise as Promise<T | undefined>,
      cancel: () => this.cancel(record.work.id)
    };
  }

  private arm(record: ScheduledRecord<unknown>): void {
    this.removeReady(record, false);
    const readyNow = record.readyAt <= this.now();
    if (record.snapshot.status === 'queued' && !record.controller.signal.aborted) {
      if (readyNow) this.readyQueue(record.work.mode).push(record);
      else this.delayedReady.push(record);
    }
    this.scheduleReadyTimer();
    if (readyNow) this.schedulePump();
  }

  private persist(record: ScheduledRecord<unknown>): void {
    const persistence = this.persistence;
    if (!persistence) return;
    const state = toScheduledTaskState(record);
    const write = this.persistenceTail.catch(() => undefined).then(() => persistence.save(state));
    this.persistenceTail = write;
    void write.catch(() => undefined);
  }

  private pump(): void {
    if (this.state === 'stopping' || this.state === 'stopped') return;
    this.promoteReady();
    while (true) {
      const foreground = this.runningForeground < this.maxForeground ? this.foregroundReady.peek() : undefined;
      const background = this.runningBackground < this.maxBackground ? this.backgroundReady.peek() : undefined;
      if (!foreground && !background) return;
      const queue =
        !background || (foreground && compareScheduledRecords(foreground, background) <= 0)
          ? this.foregroundReady
          : this.backgroundReady;
      const record = queue.pop();
      if (!record || record.snapshot.status !== 'queued' || record.controller.signal.aborted) continue;
      this.acquireSlot(record);
      void this.execute(record);
    }
  }

  private schedulePump(): void {
    if (this.pumpScheduled) return;
    this.pumpScheduled = true;
    queueMicrotask(() => {
      this.pumpScheduled = false;
      this.pump();
    });
  }

  private promoteReady(): void {
    const now = this.now();
    while (true) {
      const record = this.delayedReady.peek();
      if (!record || record.readyAt > now) break;
      this.delayedReady.pop();
      if (record.snapshot.status === 'queued' && !record.controller.signal.aborted) {
        this.readyQueue(record.work.mode).push(record);
      }
    }
    this.scheduleReadyTimer();
  }

  private scheduleReadyTimer(): void {
    const next = this.delayedReady.peek();
    if (!next) {
      if (this.readyTimer) clearTimeout(this.readyTimer.handle);
      this.readyTimer = undefined;
      return;
    }
    if (this.readyTimer?.readyAt === next.readyAt) return;
    if (this.readyTimer) clearTimeout(this.readyTimer.handle);
    const readyAt = next.readyAt;
    const handle = setTimeout(
      () => {
        this.readyTimer = undefined;
        this.promoteReady();
        this.schedulePump();
      },
      Math.max(0, readyAt - this.now())
    );
    this.readyTimer = { readyAt, handle };
  }

  private readyQueue(mode: ScheduledMode): ScheduledPriorityQueue {
    return isForegroundMode(mode) ? this.foregroundReady : this.backgroundReady;
  }

  private removeReady(record: ScheduledRecord<unknown>, refreshTimer = true): void {
    this.readyQueue(record.work.mode).remove(record.work.id);
    const removedDelayed = this.delayedReady.remove(record.work.id);
    if (removedDelayed && refreshTimer) this.scheduleReadyTimer();
  }

  private acquireSlot(record: ScheduledRecord<unknown>): void {
    if (record.slotAcquired) return;
    if (isForegroundMode(record.work.mode)) this.runningForeground += 1;
    else this.runningBackground += 1;
    record.slotAcquired = true;
  }

  private releaseSlot(record: ScheduledRecord<unknown>): void {
    if (!record.slotAcquired) return;
    if (isForegroundMode(record.work.mode)) this.runningForeground -= 1;
    else this.runningBackground -= 1;
    record.slotAcquired = false;
  }

  private findDuplicate(dedupeKey?: string): ScheduledRecord<unknown> | undefined {
    if (!dedupeKey) return undefined;
    const candidates = this.dedupeIndex.get(dedupeKey);
    if (!candidates) return undefined;
    let duplicate: ScheduledRecord<unknown> | undefined;
    for (const record of candidates) {
      if (isTerminal(record.snapshot.status)) {
        candidates.delete(record);
      } else if (!duplicate || record.sequence < duplicate.sequence) {
        duplicate = record;
      }
    }
    if (candidates.size === 0) this.dedupeIndex.delete(dedupeKey);
    return duplicate;
  }

  private registerDedupe(record: ScheduledRecord<unknown>): void {
    const dedupeKey = record.dedupeKey;
    if (!dedupeKey || isTerminal(record.snapshot.status)) return;
    const candidates = this.dedupeIndex.get(dedupeKey) ?? new Set<ScheduledRecord<unknown>>();
    candidates.add(record);
    this.dedupeIndex.set(dedupeKey, candidates);
  }

  private releaseDedupe(record: ScheduledRecord<unknown>): void {
    const dedupeKey = record.dedupeKey;
    if (!dedupeKey) return;
    const candidates = this.dedupeIndex.get(dedupeKey);
    if (!candidates) return;
    candidates.delete(record);
    if (candidates.size === 0) this.dedupeIndex.delete(dedupeKey);
  }

  private async execute(record: ScheduledRecord<unknown>): Promise<void> {
    if (record.snapshot.status !== 'queued' || record.controller.signal.aborted) return;
    const generation = record.generation;
    const controller = record.controller;
    const resumeFrom = record.resumeFrom;
    record.resumeFrom = undefined;
    record.snapshot.status = 'running';
    record.snapshot.startedAt = record.snapshot.startedAt ?? this.now();
    record.snapshot.error = undefined;
    record.attempts += 1;
    record.snapshot.attempts = record.attempts;
    this.persist(record);
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
      this.releaseSlot(record);
      record.snapshot.status = 'completed';
      record.snapshot.finishedAt = this.now();
      this.releaseDedupe(record);
      this.persist(record);
      this.emit({ type: 'completed', snapshot: this.status(record.work.id) });
      record.resolve(value);
    } catch (error) {
      if (!this.isCurrent(record, generation)) return;
      if (isRetryable(error) && record.attempts < Math.max(1, record.work.maxAttempts ?? 1)) {
        this.releaseSlot(record);
        record.controller = new AbortController();
        record.generation += 1;
        record.snapshot.status = 'queued';
        const delay = Math.max(0, record.work.retryDelayMs ?? 0);
        record.readyAt = this.now() + delay;
        this.persist(record);
        this.emit({ type: 'retrying', snapshot: this.status(record.work.id) });
        this.arm(record);
      } else if (controller.signal.aborted) {
        this.finishCancelled(record);
      } else {
        this.releaseSlot(record);
        record.snapshot.status = 'failed';
        this.releaseDedupe(record);
        record.snapshot.error = error instanceof Error ? error : new Error(String(error));
        record.snapshot.finishedAt = this.now();
        this.persist(record);
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
    this.persist(record);
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
    this.removeReady(record);
    this.releaseSlot(record);
    record.snapshot.status = 'cancelled';
    record.snapshot.finishedAt = this.now();
    this.releaseDedupe(record);
    this.persist(record);
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

function normalizePriority(priority: number | undefined): number {
  return typeof priority === 'number' && Number.isFinite(priority) ? priority : 0;
}

function compareScheduledRecords(left: ScheduledRecord<unknown>, right: ScheduledRecord<unknown>): number {
  return right.priority - left.priority || left.work.id.localeCompare(right.work.id);
}

function compareReadyRecords(left: ScheduledRecord<unknown>, right: ScheduledRecord<unknown>): number {
  return left.readyAt - right.readyAt || compareScheduledRecords(left, right);
}

function isForegroundMode(mode: ScheduledMode): boolean {
  return mode === 'interactive' || mode === 'foreground';
}

function parentIndex(index: number): number {
  return Math.floor((index - 1) / 2);
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

function cloneSnapshot(snapshot: ScheduledSnapshot): ScheduledSnapshot {
  const copy = { ...snapshot };
  if (snapshot.checkpoint) copy.checkpoint = cloneCheckpoint(snapshot.checkpoint);
  return copy;
}

function cloneScheduledState(state: ScheduledTaskState): ScheduledTaskState {
  return {
    ...state,
    snapshot: cloneSnapshot(state.snapshot)
  };
}

function toScheduledTaskState(record: ScheduledRecord<unknown>): ScheduledTaskState {
  return {
    id: record.work.id,
    mode: record.work.mode,
    status: record.snapshot.status,
    snapshot: cloneSnapshot(record.snapshot),
    attempts: record.attempts,
    readyAt: record.readyAt
  };
}

function interruptedError(message = 'Scheduled task was interrupted; resume it to continue'): Error {
  const error = new Error(message);
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
