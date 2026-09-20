import type { WriterLeaseInfo } from '@inkpi/protocol';
import type { InkDb } from './db.js';

export interface WriterLeaseGrant extends WriterLeaseInfo {
  leaseId: string;
}

interface LeaseRow {
  id: string;
  holder_id: string;
  acquired_at: number;
  expires_at: number;
  fencing_token: number;
  metadata: string | null;
}

export class WriterLeaseManager {
  private db: InkDb;
  private defaultTtlMs: number;

  constructor(db: InkDb, defaultTtlMs = 30000) {
    if (!Number.isFinite(defaultTtlMs) || defaultTtlMs <= 0) {
      throw new Error('Writer lease TTL must be a positive finite number');
    }
    this.db = db;
    this.defaultTtlMs = defaultTtlMs;
  }

  /**
   * Try to acquire an exclusive lease. The boolean API remains for callers
   * that only need collision detection; mutation paths should use acquireLease
   * to retain the fencing token.
   */
  public acquire(leaseId: string, holderId: string, ttlMs = this.defaultTtlMs, metadata?: string): boolean {
    return this.acquireLease(leaseId, holderId, ttlMs, metadata) !== undefined;
  }

  /** Acquire a lease and return its monotonically increasing fencing token. */
  public acquireLease(
    leaseId: string,
    holderId: string,
    ttlMs = this.defaultTtlMs,
    metadata?: string
  ): WriterLeaseGrant | undefined {
    validateLeaseArguments(leaseId, holderId, ttlMs);
    const now = Date.now();
    const expiresAt = now + ttlMs;

    return this.db.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM writer_leases WHERE id = ?').get(leaseId) as LeaseRow | undefined;
      const existingExpiresAt = existing ? Number(existing.expires_at) : 0;
      const isActive = existing !== undefined && existingExpiresAt > now;

      if (isActive && existing.holder_id !== holderId) {
        return undefined;
      }

      const fencingToken = Math.max(0, Number(existing?.fencing_token ?? 0)) + 1;
      this.db
        .prepare(`
          INSERT INTO writer_leases
            (id, holder_id, acquired_at, expires_at, fencing_token, metadata)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            holder_id = excluded.holder_id,
            acquired_at = excluded.acquired_at,
            expires_at = excluded.expires_at,
            fencing_token = excluded.fencing_token,
            metadata = excluded.metadata
        `)
        .run(leaseId, holderId, now, expiresAt, fencingToken, metadata ?? null);

      return {
        leaseId,
        holderId,
        acquiredAt: now,
        expiresAt,
        fencingToken,
        ...(metadata === undefined ? {} : { metadata })
      };
    });
  }

  /** Renew a lease. Passing a fencing token prevents stale same-holder renewal. */
  public renew(leaseId: string, holderId: string, ttlMs = this.defaultTtlMs, fencingToken?: number): boolean {
    validateLeaseArguments(leaseId, holderId, ttlMs);
    if (fencingToken !== undefined) validateFencingToken(fencingToken);
    const now = Date.now();
    const expiresAt = now + ttlMs;
    const statement =
      fencingToken === undefined
        ? this.db.prepare(`
            UPDATE writer_leases
            SET expires_at = ?
            WHERE id = ? AND holder_id = ? AND expires_at > ?
          `)
        : this.db.prepare(`
            UPDATE writer_leases
            SET expires_at = ?
            WHERE id = ? AND holder_id = ? AND fencing_token = ? AND expires_at > ?
          `);
    const result =
      fencingToken === undefined
        ? statement.run(expiresAt, leaseId, holderId, now)
        : statement.run(expiresAt, leaseId, holderId, fencingToken, now);
    return Number(result.changes) > 0;
  }

  /**
   * Release a lease. The historical row is retained with an expired timestamp
   * so its fencing sequence cannot reset when a new holder acquires the lease.
   * Queue-managed mutations always pass the fencing token; the optional legacy
   * form is retained for existing administrative callers.
   */
  public release(leaseId: string, holderId: string, fencingToken?: number): boolean {
    validateLeaseArguments(leaseId, holderId, 1);
    if (fencingToken !== undefined) validateFencingToken(fencingToken);
    const releasedAt = Date.now() - 1;
    const statement =
      fencingToken === undefined
        ? this.db.prepare('UPDATE writer_leases SET expires_at = ?, metadata = NULL WHERE id = ? AND holder_id = ?')
        : this.db.prepare(
            'UPDATE writer_leases SET expires_at = ?, metadata = NULL WHERE id = ? AND holder_id = ? AND fencing_token = ?'
          );
    const result =
      fencingToken === undefined
        ? statement.run(releasedAt, leaseId, holderId)
        : statement.run(releasedAt, leaseId, holderId, fencingToken);
    return Number(result.changes) > 0;
  }

  /** Get the current lease, including the token required to fence writes. */
  public getLease(leaseId: string): WriterLeaseInfo | undefined {
    const row = this.db.prepare('SELECT * FROM writer_leases WHERE id = ?').get(leaseId) as LeaseRow | undefined;
    if (!row) return undefined;

    return {
      holderId: row.holder_id,
      acquiredAt: Number(row.acquired_at),
      expiresAt: Number(row.expires_at),
      fencingToken: Number(row.fencing_token ?? 0),
      ...(row.metadata === null ? {} : { metadata: row.metadata })
    };
  }

  /** Return true only while the lease is held by the supplied token. */
  public isLeaseActive(leaseId: string, holderId: string, fencingToken: number): boolean {
    validateFencingToken(fencingToken);
    const lease = this.getLease(leaseId);
    return Boolean(
      lease && lease.holderId === holderId && lease.fencingToken === fencingToken && lease.expiresAt > Date.now()
    );
  }

  /** Check whether a different holder currently owns an unexpired lease. */
  public isLockedByOther(leaseId: string, currentHolderId: string): boolean {
    const lease = this.getLease(leaseId);
    return Boolean(lease && lease.expiresAt > Date.now() && lease.holderId !== currentHolderId);
  }
}

function validateLeaseArguments(leaseId: string, holderId: string, ttlMs: number): void {
  if (!leaseId.trim()) throw new Error('Writer lease id must not be empty');
  if (!holderId.trim()) throw new Error('Writer lease holder id must not be empty');
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new Error('Writer lease TTL must be a positive finite number');
  }
}

function validateFencingToken(fencingToken: number): void {
  if (!Number.isSafeInteger(fencingToken) || fencingToken < 1) {
    throw new Error('Writer lease fencing token must be a positive safe integer');
  }
}
