import type {
  AiTask,
  TaskCancelResult,
  TaskError,
  TaskResult,
  TaskStatus,
  TaskStatusSnapshot,
  TaskSubmitResult
} from '@inkpi/protocol';
import type { ToolCallContent, ToolResultMessage } from '@inkpi/protocol';
import { ContextPipeline } from '../context/index.js';
import { InstructionRegistry } from '../instructions/instruction-registry.js';
import { TaskScheduler } from '../lifecycle/scheduler.js';
import type { TaskRunObserver } from '../telemetry/task-observability.js';
import { ToolRegistry } from '../tools.js';
import { InMemoryTaskCheckpointStore, type TaskCheckpointStore } from './checkpoints.js';
import {
  type ExecutionAttempt,
  type ExecutionRun,
  type ExecutionStep,
  InMemoryTaskExecutionStore,
  type ResumeToken,
  type TaskExecutionRecord,
  type TaskExecutionStore
} from './execution-store.js';
import type { TaskHandler, TaskHandlerResult } from './task-handler.js';
import { TaskRegistry } from './task-registry.js';

export interface TaskRouterEvent {
  type:
    | 'created'
    | 'queued'
    | 'started'
    | 'progress'
    | 'checkpointed'
    | 'waiting-user'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';
  taskId: string;
  snapshot: TaskStatusSnapshot;
}

export type TaskRouterListener = (event: TaskRouterEvent) => void | Promise<void>;

export interface TaskRouterOptions {
  registry?: TaskRegistry;
  contextPipeline?: ContextPipeline;
  now?: () => number;
  observer?: TaskRunObserver;
  checkpointStore?: TaskCheckpointStore;
  executionStore?: TaskExecutionStore;
  instructionRegistry?: InstructionRegistry;
  toolRegistry?: ToolRegistry;
  scheduler?: TaskScheduler;
  retryDelayMs?: number;
}

interface TaskRecord {
  task: AiTask;
  controller: AbortController;
  snapshot: TaskStatusSnapshot;
  completion: Promise<TaskResult>;
  resolveCompletion: (result: TaskResult) => void;
  attempts: number;
  maxAttempts: number;
  executionRun: ExecutionRun;
  executionSteps: ExecutionStep[];
  executionAttempts: ExecutionAttempt[];
  resumeToken?: ResumeToken;
  steering: unknown[];
  scheduled?: { id: string; cancel: () => boolean };
  scheduleSequence: number;
}

export class TaskRouter {
  readonly registry: TaskRegistry;
  readonly contextPipeline: ContextPipeline;
  /** Resolves after asynchronous execution recovery and its normalization writes finish. */
  readonly ready: Promise<void>;
  private readonly now: () => number;
  private readonly observer?: TaskRunObserver;
  private readonly checkpointStore: TaskCheckpointStore;
  private readonly executionStore: TaskExecutionStore;
  private readonly instructionRegistry: InstructionRegistry;
  readonly toolRegistry: ToolRegistry;
  readonly scheduler: TaskScheduler;
  private readonly retryDelayMs: number;
  private readonly records = new Map<string, TaskRecord>();
  private readonly listeners = new Set<TaskRouterListener>();
  private persistenceTail: Promise<void> = Promise.resolve();
  private recoveryPending = true;
  private stopPromise?: Promise<void>;
  private stopping = false;

  constructor(options: TaskRouterOptions = {}) {
    this.registry = options.registry ?? new TaskRegistry();
    this.contextPipeline = options.contextPipeline ?? new ContextPipeline();
    this.now = options.now ?? Date.now;
    this.observer = options.observer;
    this.checkpointStore = options.checkpointStore ?? new InMemoryTaskCheckpointStore();
    this.executionStore = options.executionStore ?? new InMemoryTaskExecutionStore();
    this.instructionRegistry = options.instructionRegistry ?? new InstructionRegistry();
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.scheduler = options.scheduler ?? new TaskScheduler();
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
    this.ready = this.recoverPersistedRecords();
    // Keep constructor-started recovery from becoming an unhandled rejection while
    // still exposing the original rejection to callers that await `ready`.
    void this.ready.catch(() => undefined);
  }

  /** Alias for callers that prefer an explicit recovery gate. */
  whenReady(): Promise<void> {
    return this.ready;
  }

  subscribe(listener: TaskRouterListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  submit(task: AiTask): TaskSubmitResult {
    validateTask(task);
    if (this.recoveryPending) {
      throw new Error('Task router is recovering; await router.ready before submitting');
    }
    if (this.records.has(task.id)) throw new Error(`Task already exists: ${task.id}`);
    const controller = new AbortController();
    let resolveCompletion!: (result: TaskResult) => void;
    const completion = new Promise<TaskResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const executionRunId = `run:${task.id}`;
    const snapshot: TaskStatusSnapshot = {
      taskId: task.id,
      kind: task.kind,
      status: 'queued',
      executionRunId,
      attempts: 0
    };
    const executionRun: ExecutionRun = {
      id: executionRunId,
      taskId: task.id,
      status: 'queued',
      attempts: 0,
      updatedAt: this.now()
    };
    const record: TaskRecord = {
      task,
      controller,
      snapshot,
      completion,
      resolveCompletion,
      attempts: 0,
      maxAttempts: Math.max(1, task.executionPolicy?.maxAttempts ?? 1),
      executionRun,
      executionSteps: [],
      executionAttempts: [],
      steering: [],
      scheduleSequence: 0
    };
    this.records.set(task.id, record);
    const persistence = this.persist(record);
    this.emit({ type: 'created', taskId: task.id, snapshot: cloneSnapshot(snapshot) });
    this.emit({ type: 'queued', taskId: task.id, snapshot: cloneSnapshot(snapshot) });
    this.queueExecution(record, persistence);
    return { taskId: task.id, status: snapshot.status };
  }

  cancel(taskId: string): TaskCancelResult {
    const record = this.getRecord(taskId);
    const terminal = isTerminal(record.snapshot.status);
    if (terminal || record.snapshot.status === 'interrupted' || record.task.executionPolicy?.cancellable === false) {
      return { taskId, cancelled: false, status: record.snapshot.status };
    }
    record.controller.abort();
    this.unschedule(record);
    this.finishCancelled(record);
    return {
      taskId,
      cancelled: true,
      status: record.snapshot.status
    };
  }

  status(taskId: string): TaskStatusSnapshot {
    return cloneSnapshot(this.getRecord(taskId).snapshot);
  }

  async wait(taskId: string): Promise<TaskResult> {
    await this.ready;
    const result = await this.getRecord(taskId).completion;
    await this.persistenceTail;
    return result;
  }

  getTask(taskId: string): AiTask {
    return cloneValue(this.getRecord(taskId).task);
  }

  /** Submit a public human steering input for the next model/tool step. */
  steer(taskId: string, input: unknown): { taskId: string; accepted: boolean } {
    const record = this.getRecord(taskId);
    if (isTerminal(record.snapshot.status) || record.snapshot.status === 'interrupted') {
      return { taskId, accepted: false };
    }
    record.steering.push(cloneValue(input));
    this.persist(record);
    return { taskId, accepted: true };
  }

  execution(taskId: string): TaskExecutionRecord {
    const record = this.getRecord(taskId);
    return this.persistedRecord(record);
  }

  replay(taskId: string, replayTaskId = `${taskId}:replay:${this.now()}`): TaskSubmitResult {
    const task = this.getTask(taskId);
    return this.submit({
      ...task,
      id: replayTaskId,
      metadata: { ...task.metadata, replayOf: taskId }
    });
  }

  fork(taskId: string, forkTaskId: string, patch: Partial<AiTask> = {}): TaskSubmitResult {
    const task = this.getTask(taskId);
    return this.submit({
      ...task,
      ...patch,
      id: forkTaskId,
      input: patch.input ?? cloneValue(task.input),
      metadata: { ...task.metadata, ...patch.metadata, forkOf: taskId }
    });
  }

  async resume(taskId: string): Promise<TaskSubmitResult> {
    await this.ready;
    if (this.stopPromise) await this.stopPromise;
    const record = this.getRecord(taskId);
    if (!['waiting-user', 'failed', 'cancelled', 'interrupted'].includes(record.snapshot.status)) {
      throw new Error(`Task ${taskId} cannot be resumed from ${record.snapshot.status}`);
    }
    const checkpoint = await this.checkpointStore.load(taskId);
    if (!checkpoint && record.snapshot.status === 'waiting-user') {
      throw new Error(`Task ${taskId} has no checkpoint to resume`);
    }
    const expectedCheckpointStep =
      record.snapshot.checkpoint?.step ??
      record.resumeToken?.checkpointStep ??
      record.executionRun.resumeToken?.checkpointStep;
    if (!checkpoint && expectedCheckpointStep) {
      throw new Error(`Task ${taskId} has no durable checkpoint to resume`);
    }
    if (checkpoint) {
      if (checkpoint.taskId !== taskId || checkpoint.kind !== record.task.kind) {
        throw new Error(`Task ${taskId} checkpoint does not match the task being resumed`);
      }
      if (expectedCheckpointStep && checkpoint.step !== expectedCheckpointStep) {
        throw new Error(`Task ${taskId} checkpoint step does not match the execution snapshot`);
      }
    }
    record.controller = new AbortController();
    record.attempts = 0;
    record.executionRun.status = 'queued';
    record.executionRun.attempts = 0;
    record.executionRun.finishedAt = undefined;
    record.executionRun.updatedAt = this.now();
    record.snapshot.status = 'queued';
    record.snapshot.attempts = 0;
    record.snapshot.result = undefined;
    record.snapshot.error = undefined;
    record.snapshot.finishedAt = undefined;
    let resolveCompletion!: (result: TaskResult) => void;
    record.completion = new Promise<TaskResult>((resolve) => {
      resolveCompletion = resolve;
    });
    record.resolveCompletion = resolveCompletion;
    await this.persist(record);
    this.emit({ type: 'queued', taskId, snapshot: cloneSnapshot(record.snapshot) });
    this.queueExecution(record);
    return { taskId, status: 'queued' };
  }

  resumeTask(taskId: string): Promise<TaskSubmitResult> {
    return this.resume(taskId);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) {
      await this.stopPromise;
      return;
    }
    this.stopping = true;
    const stopPromise = this.finishStop();
    this.stopPromise = stopPromise;
    try {
      await stopPromise;
    } finally {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = undefined;
        this.stopping = false;
      }
    }
  }

  private async finishStop(): Promise<void> {
    await this.ready;
    for (const record of this.records.values()) {
      if (isTerminal(record.snapshot.status) || record.snapshot.status === 'interrupted') continue;
      // Runtime shutdown is distinct from user cancellation: preserve the
      // execution record as resumable even for tasks that allow cancellation.
      this.finishInterrupted(record);
    }
    await this.persistenceTail;
  }

  private async execute(record: TaskRecord): Promise<void> {
    if (record.snapshot.status === 'interrupted') return;
    if (this.stopping) {
      this.finishInterrupted(record);
      return;
    }
    if (isTerminal(record.snapshot.status)) return;
    if (record.controller.signal.aborted) {
      this.finishCancelled(record);
      return;
    }
    let handler: TaskHandler;
    try {
      handler = this.registry.resolve(record.task);
    } catch (error) {
      this.finishFailed(record, toTaskError(error));
      return;
    }
    record.attempts += 1;
    const attemptStartedAt = this.now();
    const attempt: ExecutionAttempt = {
      runId: record.executionRun.id,
      attempt: record.attempts,
      startedAt: attemptStartedAt,
      status: 'running'
    };
    const step: ExecutionStep = {
      id: `step:${record.task.id}:${record.attempts}`,
      runId: record.executionRun.id,
      step: record.task.executionPolicy?.checkpoint?.step ?? record.task.kind,
      startedAt: attemptStartedAt,
      status: 'running'
    };
    record.executionAttempts.push(attempt);
    record.executionSteps.push(step);
    record.executionRun.attempts = record.attempts;
    record.executionRun.startedAt ??= attemptStartedAt;
    record.executionRun.status = 'running';
    record.executionRun.updatedAt = attemptStartedAt;
    record.snapshot.attempts = record.attempts;
    this.update(record, { status: 'running', startedAt: record.snapshot.startedAt ?? this.now() });
    this.observer?.started?.(record.task);
    try {
      const context = await this.contextPipeline.build(record.task, record.controller.signal);
      // A provider may finish after cancellation. Do not enter the handler
      // boundary once the task has been cancelled during context collection.
      if (record.controller.signal.aborted) {
        this.finishCancelled(record);
        return;
      }
      this.observer?.contextBuilt?.(record.task, context);
      const instructions = this.instructionRegistry.composeForTask(record.task.kind);
      const checkpoint = await this.checkpointStore.load(record.task.id);
      if (record.controller.signal.aborted) {
        this.finishCancelled(record);
        return;
      }
      const handlerResult = await this.executeWithTimeout(
        record,
        handler.execute({
          task: record.task,
          context,
          instructions: instructions.entryIds.length ? instructions : undefined,
          signal: record.controller.signal,
          executionRunId: record.executionRun.id,
          attempt: record.attempts,
          toolRegistry: this.toolRegistry,
          executeTool: (call: ToolCallContent): Promise<ToolResultMessage & { terminate?: boolean }> =>
            this.toolRegistry.executeTool(call, record.controller.signal, undefined, {
              taskId: record.task.id,
              executionRunId: record.executionRun.id
            }),
          consumeSteering: () => {
            const steering = record.steering.splice(0);
            return steering.map((input) => cloneValue(input));
          },
          checkpoint,
          saveCheckpoint: async (step, data) => {
            await this.checkpointStore.save({
              taskId: record.task.id,
              kind: record.task.kind,
              step,
              data,
              contextFingerprint: context.fingerprint,
              updatedAt: this.now()
            });
            const checkpointUpdatedAt = this.now();
            const resumeToken: ResumeToken = {
              taskId: record.task.id,
              checkpointStep: step,
              contextFingerprint: context.fingerprint,
              issuedAt: checkpointUpdatedAt
            };
            record.executionRun.resumeToken = resumeToken;
            record.resumeToken = resumeToken;
            record.snapshot.checkpoint = { step, updatedAt: this.now() };
            this.persist(record);
            if (record.snapshot.status === 'running') {
              this.update(record, { status: 'checkpointed' }, 'checkpointed');
              this.update(record, { status: 'running' }, 'started');
            }
          },
          reportProgress: (progress) => {
            if (record.snapshot.status !== 'running') return;
            const bounded = Math.max(0, Math.min(1, progress));
            this.observer?.progress?.(record.task, bounded);
            this.update(record, { progress: bounded }, 'progress');
          }
        })
      );
      if (isInterrupted(record)) return;
      if (record.controller.signal.aborted) {
        this.finishCancelled(record);
        return;
      }
      const outputError = validateOutput(record.task, handlerResult);
      if (outputError) {
        this.finishFailed(record, outputError);
        return;
      }
      const status = handlerResult.status ?? 'completed';
      const result: TaskResult = {
        taskId: record.task.id,
        kind: record.task.kind,
        status,
        output: handlerResult.output,
        artifactIds: handlerResult.artifactIds,
        proposalIds: handlerResult.proposalIds,
        provenance: {
          ...sanitizeProvenance(handlerResult.provenance || {}),
          executionRunId: record.executionRun.id,
          executionAttempt: record.attempts,
          instructionVersion: instructions.version,
          instructionIds: instructions.entryIds,
          instructionProvenance: instructions.references ?? instructions.entryIds.map((id) => ({ id }))
        }
      };
      if (status !== 'waiting-user') {
        await this.checkpointStore.clear(record.task.id);
        record.snapshot.checkpoint = undefined;
      }
      record.snapshot.result = result;
      record.snapshot.status = status;
      record.snapshot.finishedAt = this.now();
      this.markExecutionSettled(record, status);
      await this.persist(record);
      this.observer?.finished?.(record.task, observationFromSnapshot(record.snapshot));
      this.emit({
        type: status === 'waiting-user' ? 'waiting-user' : 'completed',
        taskId: record.task.id,
        snapshot: cloneSnapshot(record.snapshot)
      });
      record.resolveCompletion(result);
    } catch (error) {
      if (isInterrupted(record)) return;
      if (error instanceof TaskTimeoutError) {
        this.retryOrFail(record, toTaskError(error));
      } else if (record.controller.signal.aborted || isAbortError(error)) {
        this.finishCancelled(record);
      } else {
        this.retryOrFail(record, toTaskError(error));
      }
    }
  }

  private async executeWithTimeout(
    record: TaskRecord,
    operation: Promise<TaskHandlerResult>
  ): Promise<TaskHandlerResult> {
    const timeoutMs = record.task.executionPolicy?.timeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return operation;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        record.controller.abort();
        reject(new TaskTimeoutError(timeoutMs));
      }, timeoutMs);
    });
    try {
      return await Promise.race([operation, timeout]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      void operation.catch(() => undefined);
    }
  }

  private finishCancelled(record: TaskRecord): void {
    if (isTerminal(record.snapshot.status) || record.snapshot.status === 'interrupted') return;
    const result: TaskResult = {
      taskId: record.task.id,
      kind: record.task.kind,
      status: 'cancelled',
      error: { code: 'TASK_CANCELLED', message: 'Task was cancelled', retryable: true }
    };
    record.snapshot.status = 'cancelled';
    record.snapshot.result = result;
    record.snapshot.finishedAt = this.now();
    this.markExecutionSettled(record, 'cancelled', result.error);
    this.persist(record);
    this.observer?.finished?.(record.task, observationFromSnapshot(record.snapshot));
    this.emit({ type: 'cancelled', taskId: record.task.id, snapshot: cloneSnapshot(record.snapshot) });
    record.resolveCompletion(result);
  }

  private finishFailed(record: TaskRecord, error: TaskError): void {
    if (isTerminal(record.snapshot.status) || record.snapshot.status === 'interrupted') return;
    const result: TaskResult = {
      taskId: record.task.id,
      kind: record.task.kind,
      status: 'failed',
      error
    };
    record.snapshot.status = 'failed';
    record.snapshot.error = error;
    record.snapshot.result = result;
    record.snapshot.finishedAt = this.now();
    this.markExecutionSettled(record, 'failed', error);
    this.persist(record);
    this.observer?.finished?.(record.task, observationFromSnapshot(record.snapshot));
    this.emit({ type: 'failed', taskId: record.task.id, snapshot: cloneSnapshot(record.snapshot) });
    record.resolveCompletion(result);
  }

  private retryOrFail(record: TaskRecord, error: TaskError): void {
    if (error.retryable && record.attempts < record.maxAttempts) {
      record.controller = new AbortController();
      record.snapshot.status = 'queued';
      record.snapshot.error = error;
      record.snapshot.result = undefined;
      this.markExecutionRetrying(record, error);
      const persistence = this.persist(record);
      this.emit({ type: 'queued', taskId: record.task.id, snapshot: cloneSnapshot(record.snapshot) });
      void persistence.then(() => {
        const queue = () => this.queueExecution(record);
        if (this.retryDelayMs > 0) setTimeout(queue, this.retryDelayMs);
        else queueMicrotask(queue);
      });
      return;
    }
    this.finishFailed(record, error);
  }

  private update(
    record: TaskRecord,
    patch: Partial<TaskStatusSnapshot>,
    type: TaskRouterEvent['type'] = 'started'
  ): void {
    Object.assign(record.snapshot, patch);
    if (patch.status) record.executionRun.status = patch.status;
    record.executionRun.updatedAt = this.now();
    this.persist(record);
    this.emit({ type, taskId: record.task.id, snapshot: cloneSnapshot(record.snapshot) });
  }

  private finishInterrupted(record: TaskRecord): void {
    if (isTerminal(record.snapshot.status)) return;
    this.unschedule(record);
    record.controller.abort();
    record.snapshot.status = 'interrupted';
    record.snapshot.error = interruptionError('Task was interrupted by runtime shutdown; resume it to continue');
    record.snapshot.finishedAt = this.now();
    this.markExecutionSettled(record, 'interrupted', record.snapshot.error);
    this.persist(record);
    this.emit({ type: 'interrupted', taskId: record.task.id, snapshot: cloneSnapshot(record.snapshot) });
  }

  private markExecutionSettled(record: TaskRecord, status: TaskStatus, error?: TaskError): void {
    const finishedAt = record.snapshot.finishedAt ?? this.now();
    record.executionRun.status = status;
    record.executionRun.finishedAt = finishedAt;
    record.executionRun.updatedAt = finishedAt;
    const attempt = record.executionAttempts.at(-1);
    if (attempt && attempt.status === 'running') {
      attempt.status = status;
      attempt.finishedAt = finishedAt;
      attempt.error = error;
    }
    const step = record.executionSteps.at(-1);
    if (step && step.status === 'running') {
      step.status = status;
      step.finishedAt = finishedAt;
      step.error = error;
    }
  }

  private markExecutionRetrying(record: TaskRecord, error: TaskError): void {
    const updatedAt = this.now();
    record.executionRun.status = 'queued';
    record.executionRun.updatedAt = updatedAt;
    const attempt = record.executionAttempts.at(-1);
    if (attempt && attempt.status === 'running') {
      attempt.status = 'failed';
      attempt.finishedAt = updatedAt;
      attempt.error = error;
    }
    const step = record.executionSteps.at(-1);
    if (step && step.status === 'running') {
      step.status = 'failed';
      step.finishedAt = updatedAt;
      step.error = error;
    }
  }

  private queueExecution(record: TaskRecord, waitFor: Promise<void> = Promise.resolve()): void {
    queueMicrotask(() => {
      void Promise.all([this.ready, waitFor]).then(
        () => this.scheduleExecution(record),
        (error) => {
          if (this.records.get(record.task.id) === record) {
            this.finishFailed(record, {
              code: 'TASK_RECOVERY_FAILED',
              message: error instanceof Error ? error.message : String(error),
              retryable: true
            });
          }
        }
      );
    });
  }

  private scheduleExecution(record: TaskRecord): void {
    if (
      record.scheduled ||
      isTerminal(record.snapshot.status) ||
      isInterrupted(record) ||
      this.stopping ||
      record.controller.signal.aborted
    ) {
      return;
    }
    const scheduleId = `task:${record.task.id}:execution:${record.scheduleSequence++}`;
    try {
      const scheduled = this.scheduler.schedule({
        id: scheduleId,
        mode: executionMode(record.task),
        priority: executionPriority(record.task),
        run: async () => {
          if (record.scheduled?.id !== scheduleId) return;
          // A running attempt is cancelled through the durable task controller;
          // retain the scheduler slot until execute() unwinds.
          record.scheduled = undefined;
          await this.execute(record);
        }
      });
      record.scheduled = { id: scheduleId, cancel: scheduled.cancel };
      void scheduled.promise.catch(() => undefined);
    } catch (error) {
      this.finishFailed(record, {
        code: 'TASK_SCHEDULER_FAILED',
        message: error instanceof Error ? error.message : String(error),
        retryable: true
      });
    }
  }

  private unschedule(record: TaskRecord): void {
    const scheduled = record.scheduled;
    record.scheduled = undefined;
    scheduled?.cancel();
  }

  private recoverPersistedRecords(): Promise<void> {
    try {
      const loaded = this.executionStore.list();
      if (loaded instanceof Promise) {
        return loaded
          .then((records) => this.finishRecovery(records))
          .finally(() => {
            this.recoveryPending = false;
          });
      }
      const normalized = this.finishRecovery(loaded);
      this.recoveryPending = false;
      return normalized;
    } catch (error) {
      this.recoveryPending = false;
      return Promise.reject(error);
    }
  }

  private finishRecovery(records: TaskExecutionRecord[]): Promise<void> {
    for (const record of records) this.hydrate(record);
    // Hydration normalizes in-flight records to `interrupted` and queues a
    // durable write. Do not release the recovery gate before that write lands.
    return this.persistenceTail;
  }

  private hydrate(stored: TaskExecutionRecord): void {
    if (this.records.has(stored.task.id)) return;
    const snapshot = cloneSnapshot(stored.snapshot);
    if (!isTerminal(snapshot.status) && snapshot.status !== 'interrupted') {
      snapshot.status = 'interrupted';
      snapshot.error = interruptionError('Task was interrupted before the previous runtime stopped');
      snapshot.finishedAt = this.now();
    } else if (snapshot.status === 'interrupted') {
      snapshot.error ??= interruptionError('Task was interrupted before the previous runtime stopped');
      snapshot.finishedAt ??= this.now();
    }
    let resolveCompletion!: (result: TaskResult) => void;
    const completion = new Promise<TaskResult>((resolve) => {
      resolveCompletion = resolve;
    });
    const record: TaskRecord = {
      task: cloneValue(stored.task),
      controller: new AbortController(),
      snapshot,
      completion,
      resolveCompletion,
      attempts: stored.attempts,
      maxAttempts: Math.max(1, stored.task.executionPolicy?.maxAttempts ?? 1),
      executionRun: stored.run ?? {
        id: snapshot.executionRunId ?? `run:${stored.task.id}`,
        taskId: stored.task.id,
        status: snapshot.status,
        startedAt: snapshot.startedAt,
        finishedAt: snapshot.finishedAt,
        attempts: stored.attempts,
        updatedAt: stored.updatedAt,
        resumeToken: stored.resumeToken
      },
      executionSteps: stored.steps ? cloneValue(stored.steps) : [],
      executionAttempts: stored.executionAttempts ? cloneValue(stored.executionAttempts) : [],
      resumeToken: stored.resumeToken ?? stored.run?.resumeToken,
      steering: stored.steering ? cloneValue(stored.steering) : [],
      scheduleSequence: 0
    };
    snapshot.executionRunId = record.executionRun.id;
    snapshot.attempts = stored.attempts;
    if (snapshot.status === 'interrupted') {
      record.executionRun.status = 'interrupted';
      record.executionRun.finishedAt = snapshot.finishedAt;
      record.executionRun.updatedAt = this.now();
    }
    this.records.set(record.task.id, record);
    if (snapshot.status === 'interrupted') {
      this.markExecutionSettled(record, 'interrupted', snapshot.error);
    }
    if (snapshot.result && isTerminal(snapshot.status)) resolveCompletion(snapshot.result);
    this.persist(record);
  }

  private persist(record: TaskRecord): Promise<void> {
    const persisted = this.persistedRecord(record);
    this.persistenceTail = this.persistenceTail.then(() => this.executionStore.save(persisted)).catch(() => undefined);
    return this.persistenceTail;
  }

  private persistedRecord(record: TaskRecord): TaskExecutionRecord {
    const updatedAt = this.now();
    record.executionRun.updatedAt = updatedAt;
    record.snapshot.executionRunId = record.executionRun.id;
    record.snapshot.attempts = record.attempts;
    return {
      task: cloneValue(record.task),
      snapshot: cloneSnapshot(record.snapshot),
      attempts: record.attempts,
      updatedAt,
      run: cloneValue(record.executionRun),
      steps: cloneValue(record.executionSteps),
      executionAttempts: cloneValue(record.executionAttempts),
      resumeToken: record.resumeToken ? cloneValue(record.resumeToken) : undefined,
      steering: cloneValue(record.steering)
    };
  }

  private emit(event: TaskRouterEvent): void {
    for (const listener of this.listeners) void listener(event);
  }

  private getRecord(taskId: string): TaskRecord {
    const record = this.records.get(taskId);
    if (!record) throw new Error(`Unknown task: ${taskId}`);
    return record;
  }
}

export class TaskTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Task exceeded its timeout of ${timeoutMs}ms`);
    this.name = 'TaskTimeoutError';
  }
}

function validateTask(task: AiTask): void {
  if (!task.id.trim()) throw new Error('Task id must not be empty');
  if (!task.kind.trim()) throw new Error('Task kind must not be empty');
  if (!task.input || typeof task.input !== 'object') throw new Error('Task input must be an object');
}

function validateOutput(task: AiTask, result: TaskHandlerResult): TaskError | undefined {
  const contract = task.outputContract;
  if (!contract) return undefined;
  if (!result.output) {
    if (contract.allowEmpty) return undefined;
    return { code: 'MISSING_OUTPUT', message: `Task did not produce ${contract.format} output` };
  }
  if (result.output.format !== contract.format) {
    return {
      code: 'OUTPUT_CONTRACT_MISMATCH',
      message: `Expected ${contract.format} output, received ${result.output.format}`
    };
  }
  if (result.output.format === 'text' && !contract.allowEmpty && result.output.text.length === 0) {
    return { code: 'EMPTY_OUTPUT', message: 'Task produced empty text output' };
  }
  return undefined;
}

function toTaskError(error: unknown): TaskError {
  if (error instanceof TaskTimeoutError) {
    return { code: 'TASK_TIMEOUT', message: error.message, retryable: true };
  }
  if (error instanceof Error) {
    const metadata = error as Error & { retryable?: boolean; details?: unknown };
    return {
      code: 'TASK_FAILED',
      message: error.message,
      retryable: metadata.retryable,
      details: metadata.details
    };
  }
  return { code: 'TASK_FAILED', message: String(error) };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isTerminal(status: TaskStatus): boolean {
  return status === 'waiting-user' || status === 'completed' || status === 'failed' || status === 'cancelled';
}

function isInterrupted(record: TaskRecord): boolean {
  return record.snapshot.status === 'interrupted';
}

function isCancelled(record: TaskRecord): boolean {
  return record.snapshot.status === 'cancelled' || record.controller.signal.aborted;
}

function executionMode(task: AiTask): 'interactive' | 'foreground' | 'background' | 'batch' {
  return task.executionPolicy?.mode ?? task.executionPolicy?.scheduling ?? 'foreground';
}

function executionPriority(task: AiTask): number {
  const priority = task.executionPolicy?.priority;
  if (typeof priority === 'number') return priority;
  if (priority === 'high') return 100;
  if (priority === 'low') return -100;
  return 0;
}

function interruptionError(message: string): TaskError {
  return { code: 'TASK_INTERRUPTED', message, retryable: true };
}

function cloneSnapshot(snapshot: TaskStatusSnapshot): TaskStatusSnapshot {
  return {
    ...snapshot,
    result: snapshot.result ? { ...snapshot.result } : undefined,
    error: snapshot.error ? { ...snapshot.error } : undefined,
    checkpoint: snapshot.checkpoint ? { ...snapshot.checkpoint } : undefined
  };
}

function observationFromSnapshot(snapshot: TaskStatusSnapshot) {
  const resultProvenance = snapshot.result?.provenance ? sanitizeProvenance(snapshot.result.provenance) : {};
  return {
    taskId: snapshot.taskId,
    kind: snapshot.kind,
    status: snapshot.status,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    progress: snapshot.progress,
    ...resultProvenance,
    error: snapshot.error ? { code: snapshot.error.code, message: snapshot.error.message } : undefined,
    artifactIds: snapshot.result?.artifactIds ? [...snapshot.result.artifactIds] : undefined,
    proposalIds: snapshot.result?.proposalIds ? [...snapshot.result.proposalIds] : undefined,
    checkpoint: snapshot.checkpoint ? { ...snapshot.checkpoint } : undefined,
    resultType: snapshot.result?.output?.format,
    provenance: { taskId: snapshot.taskId, taskKind: snapshot.kind, ...resultProvenance }
  };
}

function sanitizeProvenance(provenance: Record<string, unknown>): Record<string, unknown> {
  const privateReasoningKeys = new Set(['thinking', 'reasoning', 'chainOfThought', 'cot', 'rawThinking']);
  const sanitize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sanitize);
    if (value === null || typeof value !== 'object') return value;
    const safe: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (!privateReasoningKeys.has(key)) safe[key] = sanitize(nestedValue);
    }
    return safe;
  };
  return sanitize(provenance) as Record<string, unknown>;
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
