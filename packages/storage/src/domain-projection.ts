import type {
  DomainChange,
  DomainChangeSet,
  DomainProjectionApplyResult,
  DomainProjectionCursor,
  DomainProjectionSnapshot
} from '@inkpi/protocol';
import { calculateDomainChangeSetChecksum } from '@inkpi/protocol';
import { DomainMaterializer, type GenericDomainProjection } from './domain-materializer.js';
import type { IDb } from './ports.js';

export { DomainMaterializer, DomainMaterializer as DomainProjectionMaterializer } from './domain-materializer.js';

export class DomainProjectionStore {
  private readonly materializer: DomainMaterializer;

  constructor(
    private readonly db: IDb,
    private readonly now: () => number = Date.now
  ) {
    this.materializer = new DomainMaterializer(db);
  }

  public apply(changeSet: DomainChangeSet): DomainProjectionApplyResult {
    validateChangeSet(changeSet);
    return this.db.transaction(() => {
      const existing = this.db
        .prepare('SELECT id, workspace_id, source_device_id, revision, checksum FROM domain_change_sets WHERE id = ?')
        .get(changeSet.id) as
        | { id: string; workspace_id: string; source_device_id: string; revision: number; checksum: string }
        | undefined;
      if (existing) {
        if (
          existing.workspace_id !== changeSet.workspaceId ||
          existing.source_device_id !== changeSet.sourceDeviceId ||
          existing.checksum !== changeSet.checksum ||
          Number(existing.revision) !== changeSet.revision
        ) {
          throw new Error(`Domain change set id collision: ${changeSet.id}`);
        }
        return {
          accepted: true,
          duplicate: true,
          workspaceId: changeSet.workspaceId,
          revision: Number(existing.revision)
        };
      }

      const cursor = this.getCursor(changeSet.workspaceId);
      if (changeSet.baseRevision !== cursor.revision || changeSet.revision !== cursor.revision + 1) {
        return {
          accepted: false,
          duplicate: false,
          workspaceId: changeSet.workspaceId,
          revision: cursor.revision,
          reason: 'revision-conflict'
        };
      }

      this.db
        .prepare(
          `INSERT INTO domain_change_sets
            (id, workspace_id, source_device_id, base_revision, revision, changes_json, checksum, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          changeSet.id,
          changeSet.workspaceId,
          changeSet.sourceDeviceId,
          changeSet.baseRevision,
          changeSet.revision,
          serializeChanges(changeSet.changes),
          changeSet.checksum,
          changeSet.createdAt
        );
      this.materializer.applyInTransaction(changeSet.workspaceId, changeSet.changes);
      const updatedAt = this.now();
      this.db
        .prepare(
          `INSERT INTO domain_projection_cursors (workspace_id, revision, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`
        )
        .run(changeSet.workspaceId, changeSet.revision, updatedAt);
      return {
        accepted: true,
        duplicate: false,
        workspaceId: changeSet.workspaceId,
        revision: changeSet.revision
      };
    });
  }

  public getCursor(workspaceId: string): DomainProjectionCursor {
    const row = this.db
      .prepare('SELECT workspace_id, revision, updated_at FROM domain_projection_cursors WHERE workspace_id = ?')
      .get(workspaceId) as { workspace_id: string; revision: number; updated_at: number } | undefined;
    if (!row) return { workspaceId, revision: 0, updatedAt: 0 };
    return {
      workspaceId: row.workspace_id,
      revision: Number(row.revision),
      updatedAt: Number(row.updated_at)
    };
  }

  public getGenericProjection(
    workspaceId: string,
    aggregateType: string,
    aggregateId: string,
  ): GenericDomainProjection | undefined {
    return this.materializer.getGenericProjection(workspaceId, aggregateType, aggregateId);
  }

  public listGenericProjections(workspaceId: string, aggregateType?: string): GenericDomainProjection[] {
    return this.materializer.listGenericProjections(workspaceId, aggregateType);
  }

  public list(workspaceId: string, afterRevision = 0): DomainChangeSet[] {
    if (!workspaceId.trim() || !Number.isInteger(afterRevision) || afterRevision < 0) {
      throw new Error('Domain projection query has invalid workspace or cursor');
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM domain_change_sets
         WHERE workspace_id = ? AND revision > ? ORDER BY revision ASC`
      )
      .all(workspaceId, afterRevision) as Array<Record<string, unknown>>;
    let expectedRevision = afterRevision + 1;
    return rows.map((row) => {
      const changeSet = {
        id: String(row.id),
        workspaceId: String(row.workspace_id),
        sourceDeviceId: String(row.source_device_id),
        baseRevision: Number(row.base_revision),
        revision: Number(row.revision),
        changes: deserializeChanges(String(row.changes_json)),
        checksum: String(row.checksum),
        createdAt: Number(row.created_at)
      } satisfies DomainChangeSet;
      const { checksum: _checksum, ...unsigned } = changeSet;
      if (calculateDomainChangeSetChecksum(unsigned) !== changeSet.checksum) {
        // Versions before the reversible encoding persisted optional delete
        // payloads by omitting them from JSON. Accept that exact historical
        // representation while returning the typed shape to callers.
        const legacyChanges = changeSet.changes.map((change) =>
          Object.prototype.hasOwnProperty.call(change, 'payload') ? change : { ...change, payload: undefined }
        ) as DomainChange[];
        const legacyUnsigned = { ...unsigned, changes: legacyChanges };
        if (calculateDomainChangeSetChecksum(legacyUnsigned) !== changeSet.checksum) {
          throw new Error(`Corrupt domain change set checksum: ${changeSet.id}`);
        }
        changeSet.changes = legacyChanges;
      }
      if (changeSet.revision !== expectedRevision || changeSet.baseRevision !== changeSet.revision - 1) {
        throw new Error('Domain projection change log is out of order');
      }
      expectedRevision += 1;
      return changeSet;
    });
  }

  public createSnapshot(workspaceId: string): DomainProjectionSnapshot {
    const cursor = this.getCursor(workspaceId);
    const changeSets = this.list(workspaceId);
    if ((changeSets.at(-1)?.revision ?? 0) !== cursor.revision) {
      throw new Error('Domain projection cursor does not match its change log');
    }
    return {
      workspaceId,
      revision: cursor.revision,
      changeSets,
      createdAt: this.now()
    };
  }

  public restoreSnapshot(snapshot: DomainProjectionSnapshot): DomainProjectionCursor {
    validateSnapshot(snapshot);
    return this.db.transaction(() => {
      this.db.prepare('DELETE FROM domain_change_sets WHERE workspace_id = ?').run(snapshot.workspaceId);
      this.db.prepare('DELETE FROM domain_projection_cursors WHERE workspace_id = ?').run(snapshot.workspaceId);
      for (const changeSet of snapshot.changeSets) {
        this.db
          .prepare(
            `INSERT INTO domain_change_sets
              (id, workspace_id, source_device_id, base_revision, revision, changes_json, checksum, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            changeSet.id,
            changeSet.workspaceId,
            changeSet.sourceDeviceId,
            changeSet.baseRevision,
            changeSet.revision,
            serializeChanges(changeSet.changes),
            changeSet.checksum,
            changeSet.createdAt
          );
      }
      this.materializer.rebuildInTransaction(snapshot.workspaceId, snapshot.changeSets);
      const updatedAt = this.now();
      this.db
        .prepare(
          `INSERT INTO domain_projection_cursors (workspace_id, revision, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`
        )
        .run(snapshot.workspaceId, snapshot.revision, updatedAt);
      return { workspaceId: snapshot.workspaceId, revision: snapshot.revision, updatedAt };
    });
  }

  /** Rebuild derived SQLite rows from the daemon's stored authoritative log. */
  public rebuild(workspaceId: string): void {
    this.db.transaction(() => {
      this.materializer.rebuildInTransaction(workspaceId, this.list(workspaceId));
    });
  }
}

function validateChangeSet(changeSet: DomainChangeSet): void {
  if (!changeSet.id.trim() || !changeSet.workspaceId.trim() || !changeSet.sourceDeviceId.trim()) {
    throw new Error('Domain change set identifiers must not be empty');
  }
  if (
    !Number.isInteger(changeSet.baseRevision) ||
    changeSet.baseRevision < 0 ||
    !Number.isInteger(changeSet.revision) ||
    changeSet.revision !== changeSet.baseRevision + 1 ||
    !Array.isArray(changeSet.changes) ||
    !changeSet.checksum
  ) {
    throw new Error('Domain change set has invalid revision or changes');
  }
  for (const change of changeSet.changes) {
    if (!change.id || !change.aggregateType || !change.aggregateId) {
      throw new Error('Domain changes require ids and aggregate coordinates');
    }
  }
  const { checksum: _checksum, ...unsigned } = changeSet;
  if (calculateDomainChangeSetChecksum(unsigned) !== changeSet.checksum) {
    throw new Error('Domain change set checksum mismatch');
  }
}

function validateSnapshot(snapshot: DomainProjectionSnapshot): void {
  if (!snapshot.workspaceId.trim() || !Number.isInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new Error('Domain projection snapshot has invalid workspace or revision');
  }
  if (!Array.isArray(snapshot.changeSets)) throw new Error('Domain projection snapshot is missing change sets');
  let expected = 1;
  const changeSetIds = new Set<string>();
  for (const changeSet of snapshot.changeSets) {
    validateChangeSet(changeSet);
    if (changeSetIds.has(changeSet.id))
      throw new Error(`Domain projection snapshot repeats change set: ${changeSet.id}`);
    changeSetIds.add(changeSet.id);
    if (
      changeSet.workspaceId !== snapshot.workspaceId ||
      changeSet.revision !== expected ||
      changeSet.baseRevision !== expected - 1
    ) {
      throw new Error('Domain projection snapshot revisions are not contiguous');
    }
    expected += 1;
  }
  if (snapshot.revision !== expected - 1)
    throw new Error('Domain projection snapshot cursor does not match its changes');
}

const UNDEFINED_SENTINEL = '__inkpi_domain_projection_undefined__';

/** JSON cannot represent undefined, but the wire checksum can. Round-trip it. */
function serializeChanges(changes: DomainChangeSet['changes']): string {
  return JSON.stringify(changes, (_key, value: unknown) =>
    value === undefined ? { [UNDEFINED_SENTINEL]: true } : value
  );
}

function deserializeChanges(serialized: string): DomainChangeSet['changes'] {
  return restoreUndefined(JSON.parse(serialized)) as DomainChangeSet['changes'];
}

function restoreUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(restoreUndefined);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 1 && record[UNDEFINED_SENTINEL] === true) return undefined;
  for (const key of Object.keys(record)) record[key] = restoreUndefined(record[key]);
  return record;
}
