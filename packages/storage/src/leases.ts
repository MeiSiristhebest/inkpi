import type { WriterLeaseInfo } from '@inkpi/protocol';
import type { InkDb } from './db.js';

export class WriterLeaseManager {
  private db: InkDb;
  private defaultTtlMs: number;

  constructor(db: InkDb, defaultTtlMs = 30000) {
    this.db = db;
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * 尝试获取指定资源的独占排他写锁租约
   */
  public acquire(leaseId: string, holderId: string, ttlMs = this.defaultTtlMs, metadata?: string): boolean {
    const now = Date.now();
    const expiresAt = now + ttlMs;

    return this.db.transaction(() => {
      // 1. Clean expired lease
      const checkStmt = this.db.prepare('SELECT * FROM writer_leases WHERE id = ?');
      const existing = checkStmt.get(leaseId) as any;

      if (!existing || Number(existing.expires_at) < now || existing.holder_id === holderId) {
        const upsertStmt = this.db.prepare(`
          INSERT INTO writer_leases (id, holder_id, acquired_at, expires_at, metadata)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            holder_id = excluded.holder_id,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at,
            metadata = excluded.metadata
        `);
        upsertStmt.run(leaseId, holderId, now, expiresAt, metadata || null);
        return true;
      }

      // Already held by another active process
      return false;
    });
  }

  /**
   * 续约指定租约 (Heartbeat)
   */
  public renew(leaseId: string, holderId: string, ttlMs = this.defaultTtlMs): boolean {
    const now = Date.now();
    const expiresAt = now + ttlMs;

    const stmt = this.db.prepare(`
      UPDATE writer_leases 
      SET expires_at = ? 
      WHERE id = ? AND holder_id = ? AND expires_at >= ?
    `);
    const res = stmt.run(expiresAt, leaseId, holderId, now);
    return Number(res.changes) > 0;
  }

  /**
   * 释放排他写锁租约
   */
  public release(leaseId: string, holderId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM writer_leases WHERE id = ? AND holder_id = ?');
    const res = stmt.run(leaseId, holderId);
    return Number(res.changes) > 0;
  }

  /**
   * 获取当前租约信息
   */
  public getLease(leaseId: string): WriterLeaseInfo | undefined {
    const stmt = this.db.prepare('SELECT * FROM writer_leases WHERE id = ?');
    const row = stmt.get(leaseId) as any;
    if (!row) return undefined;

    return {
      holderId: row.holder_id,
      acquiredAt: Number(row.acquired_at),
      expiresAt: Number(row.expires_at),
      metadata: row.metadata
    };
  }

  /**
   * 检查租约是否被他人锁定
   */
  public isLockedByOther(leaseId: string, currentHolderId: string): boolean {
    const lease = this.getLease(leaseId);
    if (!lease) return false;
    const now = Date.now();
    return lease.expiresAt >= now && lease.holderId !== currentHolderId;
  }
}
