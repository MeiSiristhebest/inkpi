import type { InkDb } from './db.js';
import { type WriterLeaseGrant, WriterLeaseManager } from './leases.js';

export interface MutationExecutionContext {
  leaseId: string;
  holderId: string;
  fencingToken: number;
  /** Throw when the caller no longer owns the fenced lease. */
  assertActive(): void;
}

export interface MutationTask<T = unknown> {
  id: string;
  documentId: string;
  holderId: string;
  execute: (context: MutationExecutionContext) => Promise<T> | T;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

/** Raised when a mutation loses its lease before settlement. */
export class MutationLeaseLostError extends Error {
  constructor(documentId: string, fencingToken: number) {
    super(`Document ${documentId} lease was lost before mutation settlement (fencing token ${fencingToken})`);
    this.name = 'MutationLeaseLostError';
  }
}

/**
 * 文档原子修改与事务锁队列 (1:1 移植自 repos/pi packages/agent/src/harness/tools/file-mutation-queue.ts)
 * 解决多 Agent 协作并发写库冲突 (基于资源粒度串行锁机制)
 */
export const DEFAULT_MUTATION_TTL_MS = 15000;

export class DocumentMutationQueue {
  private leaseManager: WriterLeaseManager;
  private defaultTtlMs: number;
  private queues = new Map<string, Array<MutationTask<any>>>();
  private activeProcessing = new Set<string>();

  constructor(db: InkDb, defaultTtlMs = DEFAULT_MUTATION_TTL_MS) {
    if (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0) {
      throw new Error('Mutation lease TTL must be a positive finite number');
    }
    this.defaultTtlMs = defaultTtlMs;
    this.leaseManager = new WriterLeaseManager(db, defaultTtlMs);
  }

  public getLeaseManager(): WriterLeaseManager {
    return this.leaseManager;
  }

  /** 将修改操作入队并按资源标识串行原子化执行。 */
  public enqueue<T>(
    documentId: string,
    holderId: string,
    mutationFn: (context: MutationExecutionContext) => Promise<T> | T
  ): Promise<T> {
    if (!documentId.trim()) throw new Error('Mutation document id must not be empty');
    if (!holderId.trim()) throw new Error('Mutation holder id must not be empty');
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
      void this.processQueue(documentId);
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
    for (const queue of this.queues.values()) {
      total += queue.length;
    }
    return total;
  }

  private async processQueue(documentId: string): Promise<void> {
    if (this.activeProcessing.has(documentId)) return;

    const queue = this.queues.get(documentId);
    if (!queue || queue.length === 0) {
      this.queues.delete(documentId);
      return;
    }

    this.activeProcessing.add(documentId);

    try {
      while (queue.length > 0) {
        const task = queue.shift()!;
        const leaseId = `lease_${documentId}`;
        const grant = this.leaseManager.acquireLease(leaseId, task.holderId, this.defaultTtlMs, `mutation:${task.id}`);

        if (!grant) {
          if (this.leaseManager.isLockedByOther(leaseId, task.holderId)) {
            task.reject(new Error(`Document ${documentId} is currently locked by another active writer`));
          } else {
            task.reject(new Error(`Document ${documentId} lease could not be acquired`));
          }
          continue;
        }

        await this.executeWithLease(task, grant);
      }
    } finally {
      this.activeProcessing.delete(documentId);
      if (queue.length === 0) {
        this.queues.delete(documentId);
      } else {
        void this.processQueue(documentId);
      }
    }
  }

  private async executeWithLease<T>(task: MutationTask<T>, grant: WriterLeaseGrant): Promise<void> {
    let leaseLost = false;
    const heartbeatIntervalMs = Math.max(1, Math.floor(this.defaultTtlMs / 3));
    const heartbeat = setInterval(() => {
      if (!this.leaseManager.renew(grant.leaseId, grant.holderId, this.defaultTtlMs, grant.fencingToken)) {
        leaseLost = true;
      }
    }, heartbeatIntervalMs);

    const context: MutationExecutionContext = {
      leaseId: grant.leaseId,
      holderId: grant.holderId,
      fencingToken: grant.fencingToken,
      assertActive: () => {
        if (leaseLost || !this.leaseManager.isLeaseActive(grant.leaseId, grant.holderId, grant.fencingToken)) {
          leaseLost = true;
          throw new MutationLeaseLostError(task.documentId, grant.fencingToken);
        }
      }
    };

    try {
      context.assertActive();
      const result = await task.execute(context);
      context.assertActive();
      task.resolve(result);
    } catch (error) {
      task.reject(error);
    } finally {
      clearInterval(heartbeat);
      this.leaseManager.release(grant.leaseId, grant.holderId, grant.fencingToken);
    }
  }
}
