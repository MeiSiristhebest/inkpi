import type { AiTask } from '@inkpi/protocol';
import type { TaskHandler, TaskHandlerContext, TaskHandlerResult } from './task-handler.js';

/** Submit chapter checks or other independent tasks through the normal durable router. */
export class TaskBatchHandler implements TaskHandler {
  readonly id = 'runtime.batch';
  readonly kinds = ['task.batch'];

  async execute({ task, signal, spawnChild }: TaskHandlerContext): Promise<TaskHandlerResult> {
    const payload = task.input.payload;
    const tasks: unknown = payload && typeof payload === 'object' && 'tasks' in payload ? payload.tasks : undefined;
    if (!Array.isArray(tasks) || tasks.length === 0) throw new Error('A task batch requires a nonempty tasks array');
    if (!spawnChild) throw new Error('A task batch requires a router child-task context');
    const ids = new Set<string>();
    const children: AiTask[] = [];
    for (const child of tasks as unknown[]) {
      if (
        !child ||
        typeof child !== 'object' ||
        !('id' in child) ||
        typeof child.id !== 'string' ||
        !('kind' in child) ||
        typeof child.kind !== 'string' ||
        !('input' in child) ||
        !child.input ||
        typeof child.input !== 'object'
      ) {
        throw new Error('A task batch contains an invalid task');
      }
      if (!child.id.trim() || !child.kind.trim() || ids.has(child.id))
        throw new Error('Task batch ids must be unique and nonempty');
      ids.add(child.id);
      children.push(child as AiTask);
    }
    for (const child of children) {
      signal.throwIfAborted();
      await spawnChild(child);
    }
    return { output: { format: 'structured', data: { taskIds: [...ids] } } };
  }
}
