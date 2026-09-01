import { WriterLeaseManager } from './leases.js';
import type { InkDb } from './db.js';

export interface MutationTask<T = unknown> {
  id: string;
  documentId: string;
  holderId: string;
  execute: () => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/**
 * 文档原子修改与事务锁队列 (1:1 移植自 repos/pi packages/agent/src/harness/tools/file-mutation-queue.ts)
 * 解决多 Agent 协作并发写库冲突 (基于资源粒度串行锁机制)
 */
export class DocumentMutationQueue {
  private leaseManager: WriterLeaseManager;
  private queues = new Map<string, Array<MutationTask<any>>>();
  private activeProcessing = new Set<string>();

  constructor(db: InkDb, defaultTtlMs = 15000) {
    this.leaseManager = new WriterLeaseManager(db, defaultTtlMs);
  }

  public getLeaseManager(): WriterLeaseManager {
    return this.leaseManager;
  }

  /**
   * 将修改操作入队并按资源标识串行原子化执行
   */
  public enqueue<T>(documentId: string, holderId: string, mutationFn: () => Promise<T> | T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const task: MutationTask<T> = {
        id: `mut_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        documentId,
        holderId,
        execute: mutationFn,
        resolve,
        reject
      };

      if (!this.queues.has(documentId)) {
        this.queues.set(documentId, []);
      }

      this.queues.get(documentId)!.push(task);
      this.processQueue(documentId);
    });
  }

  public isDocumentBusy(documentId: string): boolean {
    return this.activeProcessing.has(documentId) || (this.queues.get(documentId)?.length ?? 0) > 0;
  }

  public getPendingCount(documentId?: string): number {
    if (documentId) {
      return this.queues.get(documentId)?.length ?? 0;
    }
    let total = 0;
    for (const q of this.queues.values()) {
      total += q.length;
    }
    return total;
  }

  private async processQueue(documentId: string): Promise<void> {
    if (this.activeProcessing.has(documentId)) {
      return;
    }

    const queue = this.queues.get(documentId);
    if (!queue || queue.length === 0) {
      this.queues.delete(documentId);
      return;
    }

    this.activeProcessing.add(documentId);

    try {
      while (queue.length > 0) {
        const task = queue.shift()!;
        const leaseAcquired = this.leaseManager.acquire(
          `lease_${documentId}`,
          task.holderId,
          15000,
          `mutation:${task.id}`
        );

        if (!leaseAcquired) {
          // If locked by another distinct holder externally, retry after short backoff or reject
          if (this.leaseManager.isLockedByOther(`lease_${documentId}`, task.holderId)) {
            task.reject(new Error(`Document ${documentId} is currently locked by another active writer`));
            continue;
          }
        }

        try {
          const result = await task.execute();
          task.resolve(result);
        } catch (err) {
          task.reject(err);
        } finally {
          this.leaseManager.release(`lease_${documentId}`, task.holderId);
        }
      }
    } finally {
      this.activeProcessing.delete(documentId);
      if (queue.length === 0) {
        this.queues.delete(documentId);
      } else {
        this.processQueue(documentId);
      }
    }
  }
}
