import type { TaskResult, TaskStatusSnapshot } from './task.js';

/** Cancel a waiter without transferring cancellation to the accepted work. */
export function awaitWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    void work.catch(() => undefined);
    return Promise.reject(signal.reason ?? new DOMException('Waiting cancelled', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => {
      cleanup();
      reject(signal.reason ?? new DOMException('Waiting cancelled', 'AbortError'));
    };
    signal.addEventListener('abort', abort, { once: true });
    work.then(
      (result) => {
        cleanup();
        resolve(result);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

export async function observeTaskResult(
  taskId: string,
  readStatus: () => Promise<TaskStatusSnapshot>,
  subscribe: (listener: (snapshot: TaskStatusSnapshot) => void) => () => void,
  signal?: AbortSignal
): Promise<TaskResult> {
  signal?.throwIfAborted();
  let unsubscribe: (() => void) | undefined;
  const result = new Promise<TaskResult>((resolve, reject) => {
    const consume = (snapshot: TaskStatusSnapshot) => {
      if (snapshot.taskId !== taskId || !['waiting-user', 'completed', 'failed', 'cancelled'].includes(snapshot.status))
        return;
      if (snapshot.result) resolve(snapshot.result);
      else reject(new Error(`Task ${taskId} ended without a result`));
    };
    unsubscribe = subscribe(consume);
    void readStatus().then(consume, reject);
  });
  try {
    return await awaitWithAbort(result, signal);
  } finally {
    unsubscribe?.();
  }
}
