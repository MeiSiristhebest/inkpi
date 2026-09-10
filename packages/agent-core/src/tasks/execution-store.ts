import type { AiTask, TaskError, TaskResult, TaskStatus, TaskStatusSnapshot } from '@inkpi/protocol';

export interface ExecutionRun {
  id: string;
  taskId: string;
  status: TaskStatus;
  startedAt?: number;
  finishedAt?: number;
  attempts: number;
  updatedAt: number;
  resumeToken?: ResumeToken;
}

export interface ExecutionStep {
  id: string;
  runId: string;
  step: string;
  status: TaskStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: TaskError;
}

export interface ExecutionAttempt {
  runId: string;
  attempt: number;
  startedAt: number;
  finishedAt?: number;
  status: TaskStatus;
  error?: TaskError;
}

export interface ResumeToken {
  taskId: string;
  checkpointStep: string;
  contextFingerprint?: string;
  issuedAt: number;
}

export interface TaskExecutionRecord {
  task: AiTask;
  snapshot: TaskStatusSnapshot;
  attempts: number;
  updatedAt: number;
  /** Durable execution metadata. Optional keeps old stores readable. */
  run?: ExecutionRun;
  steps?: ExecutionStep[];
  executionAttempts?: ExecutionAttempt[];
  resumeToken?: ResumeToken;
  steering?: unknown[];
}

export interface TaskExecutionStore {
  save(record: TaskExecutionRecord): Promise<void> | void;
  load(taskId: string): Promise<TaskExecutionRecord | undefined> | TaskExecutionRecord | undefined;
  list(): Promise<TaskExecutionRecord[]> | TaskExecutionRecord[];
}

export class InMemoryTaskExecutionStore implements TaskExecutionStore {
  private readonly records = new Map<string, TaskExecutionRecord>();

  save(record: TaskExecutionRecord): void {
    this.records.set(record.task.id, cloneRecord(record));
  }

  load(taskId: string): TaskExecutionRecord | undefined {
    const record = this.records.get(taskId);
    return record ? cloneRecord(record) : undefined;
  }

  list(): TaskExecutionRecord[] {
    return [...this.records.values()].map(cloneRecord);
  }
}

function cloneRecord(record: TaskExecutionRecord): TaskExecutionRecord {
  return {
    task: cloneValue(record.task),
    snapshot: cloneValue(record.snapshot),
    attempts: record.attempts,
    updatedAt: record.updatedAt,
    run: record.run ? cloneValue(record.run) : undefined,
    steps: record.steps ? cloneValue(record.steps) : undefined,
    executionAttempts: record.executionAttempts ? cloneValue(record.executionAttempts) : undefined,
    resumeToken: record.resumeToken ? cloneValue(record.resumeToken) : undefined,
    steering: record.steering ? cloneValue(record.steering) : undefined
  };
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

export type PersistedTaskResult = TaskResult;
