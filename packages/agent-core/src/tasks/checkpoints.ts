import type { AiTask } from '@inkpi/protocol';

export interface TaskCheckpoint {
  taskId: string;
  kind: string;
  step: string;
  data: unknown;
  contextFingerprint?: string;
  updatedAt: number;
}

export interface TaskCheckpointStore {
  save(checkpoint: TaskCheckpoint): Promise<void> | void;
  load(taskId: string): Promise<TaskCheckpoint | undefined> | TaskCheckpoint | undefined;
  clear(taskId: string): Promise<void> | void;
}

export class InMemoryTaskCheckpointStore implements TaskCheckpointStore {
  private readonly checkpoints = new Map<string, TaskCheckpoint>();

  save(checkpoint: TaskCheckpoint): void {
    this.checkpoints.set(checkpoint.taskId, cloneCheckpoint(checkpoint));
  }

  load(taskId: string): TaskCheckpoint | undefined {
    const checkpoint = this.checkpoints.get(taskId);
    return checkpoint ? cloneCheckpoint(checkpoint) : undefined;
  }

  clear(taskId: string): void {
    this.checkpoints.delete(taskId);
  }
}

export function createCheckpoint(
  task: AiTask,
  step: string,
  data: unknown,
  contextFingerprint?: string,
  updatedAt = Date.now(),
): TaskCheckpoint {
  return { taskId: task.id, kind: task.kind, step, data, contextFingerprint, updatedAt };
}

function cloneCheckpoint(checkpoint: TaskCheckpoint): TaskCheckpoint {
  return {
    ...checkpoint,
    data: cloneValue(checkpoint.data),
  };
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return value;
  }
}
