import type { AiTask } from '@inkpi/protocol';
import type { TaskHandler } from './task-handler.js';

export class TaskHandlerNotFoundError extends Error {
  constructor(kind: string) {
    super(`No task handler registered for kind: ${kind}`);
    this.name = 'TaskHandlerNotFoundError';
  }
}

export class TaskRegistry {
  private readonly handlers = new Map<string, TaskHandler>();

  register(handler: TaskHandler): void {
    if (!handler.id.trim()) throw new Error('Task handler id must not be empty');
    if (!handler.kinds?.length && !handler.canHandle) {
      throw new Error(`Task handler must declare kinds or canHandle: ${handler.id}`);
    }
    if (this.handlers.has(handler.id)) {
      throw new Error(`Task handler already registered: ${handler.id}`);
    }
    this.handlers.set(handler.id, handler);
  }

  unregister(handlerId: string): boolean {
    return this.handlers.delete(handlerId);
  }

  list(): TaskHandler[] {
    return [...this.handlers.values()];
  }

  resolve(task: AiTask): TaskHandler {
    for (const handler of this.handlers.values()) {
      if (handler.kinds?.includes(task.kind)) return handler;
    }
    // Exact kind registrations are more specific than predicates and
    // wildcards, regardless of registration order. This lets a product or
    // extension override the daemon's generic fallback handler safely.
    for (const handler of this.handlers.values()) {
      if (handler.canHandle?.(task)) return handler;
    }
    for (const handler of this.handlers.values()) {
      if (handler.kinds?.includes('*')) return handler;
    }
    throw new TaskHandlerNotFoundError(task.kind);
  }
}
