import type { DomainChange, DomainChangeSet } from '@inkpi/protocol';
import type { IDb } from './ports.js';

type JsonRecord = Record<string, unknown>;

export interface GenericDomainProjection {
  workspaceId: string;
  aggregateType: string;
  aggregateId: string;
  revision: number;
  payload: unknown;
  payloadHash: string;
  updatedAt: number;
}

interface GenericDomainProjectionRow {
  workspace_id: string;
  aggregate_type: string;
  aggregate_id: string;
  revision: number;
  payload_json: string;
  payload_hash: string;
  updated_at: number;
}

interface WorkspaceRow {
  id: string;
  title: string;
  owner: string;
  category: string | null;
  target_size: number | null;
  synopsis: string | null;
  cover_image: string | null;
  metadata: string | null;
  created_at: number;
  updated_at: number;
}

interface FolderRow {
  id: string;
  workspace_id: string;
  title: string;
  order_index: number;
  summary: string | null;
  created_at: number;
  updated_at: number;
}

interface DocumentRow {
  id: string;
  folder_id: string;
  workspace_id: string;
  title: string;
  order_index: number;
  synopsis: string | null;
  content_size: number;
  status: string | null;
  created_at: number;
  updated_at: number;
}

interface SnapshotRow {
  document_id: string;
  version: number;
  content_json: string;
  content_markdown: string;
  content_size: number;
  updated_at: number;
}

/**
 * Materializes the desktop domain log into daemon read models.
 *
 * The desktop IndexedDB change log remains authoritative. This class only
 * writes the SQLite read models and is deliberately unaware of desktop
 * record types. `applyInTransaction` is used by DomainProjectionStore after
 * the change set has passed its idempotency and revision checks.
 */
export class DomainMaterializer {
  public constructor(private readonly db: IDb) {}

  /** Materialize one change set when called outside DomainProjectionStore. */
  public apply(changeSet: Pick<DomainChangeSet, 'workspaceId' | 'changes'>): void {
    this.db.transaction(() => this.applyInTransaction(changeSet.workspaceId, changeSet.changes));
  }

  /**
   * Rebuild a workspace's derived rows from its authoritative change sets.
   * Passing change sets is useful during snapshot restore; omitting them
   * reloads the persisted daemon change log.
   */
  public rebuild(workspaceId: string, changeSets?: readonly DomainChangeSet[]): void {
    this.db.transaction(() => {
      const source = changeSets ?? this.readPersistedChangeSets(workspaceId);
      this.rebuildInTransaction(workspaceId, source);
    });
  }

  public getGenericProjection(
    workspaceId: string,
    aggregateType: string,
    aggregateId: string
  ): GenericDomainProjection | undefined {
    assertGenericProjectionCoordinate(workspaceId, 'workspace');
    assertGenericProjectionCoordinate(aggregateType, 'aggregate type');
    assertGenericProjectionCoordinate(aggregateId, 'aggregate id');
    const row = this.db
      .prepare(
        `SELECT workspace_id, aggregate_type, aggregate_id, revision,
                payload_json, payload_hash, updated_at
         FROM domain_aggregate_projections
         WHERE workspace_id = ? AND aggregate_type = ? AND aggregate_id = ?`
      )
      .get(workspaceId, aggregateType, aggregateId) as GenericDomainProjectionRow | undefined;
    return row ? parseGenericProjection(row) : undefined;
  }

  public listGenericProjections(workspaceId: string, aggregateType?: string): GenericDomainProjection[] {
    assertGenericProjectionCoordinate(workspaceId, 'workspace');
    if (aggregateType !== undefined) assertGenericProjectionCoordinate(aggregateType, 'aggregate type');
    const rows = (
      aggregateType === undefined
        ? this.db.prepare(
            `SELECT workspace_id, aggregate_type, aggregate_id, revision,
                    payload_json, payload_hash, updated_at
             FROM domain_aggregate_projections
             WHERE workspace_id = ? ORDER BY aggregate_type ASC, aggregate_id ASC`
          )
        : this.db.prepare(
            `SELECT workspace_id, aggregate_type, aggregate_id, revision,
                    payload_json, payload_hash, updated_at
             FROM domain_aggregate_projections
             WHERE workspace_id = ? AND aggregate_type = ?
             ORDER BY aggregate_id ASC`
          )
    ).all(
      ...(aggregateType === undefined ? [workspaceId] : [workspaceId, aggregateType])
    ) as GenericDomainProjectionRow[];
    return rows.map(parseGenericProjection);
  }

  /** @internal Called by DomainProjectionStore inside its existing transaction. */
  public applyInTransaction(workspaceId: string, changes: readonly DomainChange[]): void {
    this.applyGenericInTransaction(workspaceId, changes);
    for (const change of orderChangesForForeignKeys(changes)) {
      const aggregate = normalizeAggregateType(change.aggregateType);
      if (change.operation === 'upsert') {
        if (aggregate === 'workspace') this.upsertWorkspace(workspaceId, change);
        else if (aggregate === 'folder') this.upsertFolder(workspaceId, change);
        else if (aggregate === 'document') this.upsertDocument(workspaceId, change);
        // Unknown aggregate types have no specialized schema. Their generic
        // JSON projection was applied above without runtime interpretation.
      } else if (change.operation === 'delete') {
        if (aggregate === 'workspace') this.deleteWorkspace(change.aggregateId);
        else if (aggregate === 'folder') this.deleteFolder(change.aggregateId);
        else if (aggregate === 'document') this.deleteDocument(change.aggregateId);
      }
    }
  }

  /** @internal Called by DomainProjectionStore inside its existing transaction. */
  public rebuildInTransaction(workspaceId: string, changeSets: readonly DomainChangeSet[]): void {
    this.deleteGenericProjections(workspaceId);
    this.deleteWorkspace(workspaceId);
    const orderedChangeSets = [...changeSets].sort((left, right) => left.revision - right.revision);
    for (const changeSet of orderedChangeSets) {
      if (changeSet.workspaceId !== workspaceId) {
        throw new Error(`Domain change set belongs to another workspace: ${changeSet.id}`);
      }
      this.applyInTransaction(workspaceId, changeSet.changes);
    }
  }

  private applyGenericInTransaction(workspaceId: string, changes: readonly DomainChange[]): void {
    for (const change of changes) {
      assertGenericProjectionCoordinate(workspaceId, 'workspace');
      assertGenericProjectionCoordinate(change.aggregateType, 'aggregate type');
      assertGenericProjectionCoordinate(change.aggregateId, 'aggregate id');
      if (change.operation === 'upsert') {
        const payloadJson = serializeProjectionPayload(change.payload);
        const payloadHash = calculatePayloadHash(payloadJson);
        this.db
          .prepare(
            `INSERT INTO domain_aggregate_projections
              (workspace_id, aggregate_type, aggregate_id, revision, payload_json, payload_hash, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(workspace_id, aggregate_type, aggregate_id) DO UPDATE SET
               revision = excluded.revision,
               payload_json = excluded.payload_json,
               payload_hash = excluded.payload_hash,
               updated_at = excluded.updated_at`
          )
          .run(
            workspaceId,
            change.aggregateType,
            change.aggregateId,
            change.revision,
            payloadJson,
            payloadHash,
            change.occurredAt
          );
      } else if (change.operation === 'delete') {
        this.db
          .prepare(
            `DELETE FROM domain_aggregate_projections
             WHERE workspace_id = ? AND aggregate_type = ? AND aggregate_id = ?`
          )
          .run(workspaceId, change.aggregateType, change.aggregateId);
      }
    }
  }

  private deleteGenericProjections(workspaceId: string): void {
    this.db.prepare('DELETE FROM domain_aggregate_projections WHERE workspace_id = ?').run(workspaceId);
  }

  private readPersistedChangeSets(workspaceId: string): DomainChangeSet[] {
    const rows = this.db
      .prepare(
        `SELECT id, workspace_id, source_device_id, base_revision, revision,
                changes_json, checksum, created_at
         FROM domain_change_sets
         WHERE workspace_id = ? ORDER BY revision ASC`
      )
      .all(workspaceId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      id: String(row.id),
      workspaceId: String(row.workspace_id),
      sourceDeviceId: String(row.source_device_id),
      baseRevision: Number(row.base_revision),
      revision: Number(row.revision),
      changes: JSON.parse(String(row.changes_json)) as DomainChange[],
      checksum: String(row.checksum ?? ''),
      createdAt: Number(row.created_at)
    }));
  }

  private upsertWorkspace(workspaceId: string, change: DomainChange): void {
    const payload = asRecord(change.payload);
    const id = change.aggregateId;
    const existing = this.db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) as WorkspaceRow | undefined;
    const title = stringValue(payload, ['title', 'name']) ?? existing?.title ?? id;
    const owner = stringValue(payload, ['owner', 'ownerId', 'owner_id', 'author']) ?? existing?.owner ?? '';
    const category =
      stringValue(payload, ['category', 'genre', 'projectType', 'project_type']) ?? existing?.category ?? 'general';
    const targetSize = numberValue(payload, ['targetSize', 'target_size']) ?? existing?.target_size ?? 0;
    const synopsis = stringValue(payload, ['description', 'synopsis', 'intro']) ?? existing?.synopsis ?? null;
    const coverImage = stringValue(payload, ['coverImage', 'cover_image', 'cover']) ?? existing?.cover_image ?? null;
    const metadata = metadataValue(payload, existing?.metadata);
    const createdAt = numberValue(payload, ['createdAt', 'created_at']) ?? existing?.created_at ?? change.occurredAt;
    const updatedAt = numberValue(payload, ['updatedAt', 'updated_at']) ?? existing?.updated_at ?? change.occurredAt;

    this.db
      .prepare(
        `INSERT INTO workspaces
          (id, title, owner, category, target_size, synopsis, cover_image, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           owner = excluded.owner,
           category = excluded.category,
           target_size = excluded.target_size,
           synopsis = excluded.synopsis,
           cover_image = excluded.cover_image,
           metadata = excluded.metadata,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`
      )
      .run(id, title, owner, category, targetSize, synopsis, coverImage, metadata, createdAt, updatedAt);

    // Desktop project changes use project.id as workspaceId. The aggregate
    // coordinate remains the canonical key even if a payload is inconsistent.
    void workspaceId;
  }

  private upsertFolder(workspaceId: string, change: DomainChange): void {
    const payload = asRecord(change.payload);
    const id = change.aggregateId;
    const existing = this.db.prepare('SELECT * FROM folders WHERE id = ?').get(id) as FolderRow | undefined;
    const parentWorkspaceId =
      stringValue(payload, ['workspaceId', 'workspace_id', 'projectId', 'project_id']) ??
      existing?.workspace_id ??
      workspaceId;
    const title = stringValue(payload, ['title', 'name']) ?? existing?.title ?? id;
    const orderIndex = numberValue(payload, ['orderIndex', 'order_index', 'order']) ?? existing?.order_index ?? 0;
    const summary = stringValue(payload, ['summary', 'description', 'intro']) ?? existing?.summary ?? null;
    const createdAt = numberValue(payload, ['createdAt', 'created_at']) ?? existing?.created_at ?? change.occurredAt;
    const updatedAt = numberValue(payload, ['updatedAt', 'updated_at']) ?? existing?.updated_at ?? change.occurredAt;

    // A child event can arrive before its parent event during an incremental
    // sync. Keep the authoritative change set and create a minimal derived
    // parent; a later parent upsert replaces its placeholder values.
    this.ensureWorkspace(parentWorkspaceId, change.occurredAt);

    this.db
      .prepare(
        `INSERT INTO folders
          (id, workspace_id, title, order_index, summary, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           workspace_id = excluded.workspace_id,
           title = excluded.title,
           order_index = excluded.order_index,
           summary = excluded.summary,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`
      )
      .run(id, parentWorkspaceId, title, orderIndex, summary, createdAt, updatedAt);
  }

  private upsertDocument(workspaceId: string, change: DomainChange): void {
    const payload = asRecord(change.payload);
    const id = change.aggregateId;
    const existing = this.db.prepare('SELECT * FROM documents WHERE id = ?').get(id) as DocumentRow | undefined;
    const parentWorkspaceId =
      stringValue(payload, ['workspaceId', 'workspace_id', 'projectId', 'project_id']) ??
      existing?.workspace_id ??
      workspaceId;
    const explicitFolderId = stringValue(payload, ['folderId', 'folder_id', 'volumeId', 'volume_id']);
    const folderId = explicitFolderId ?? existing?.folder_id;
    const title = stringValue(payload, ['title', 'name']) ?? existing?.title ?? id;
    const orderIndex = numberValue(payload, ['orderIndex', 'order_index', 'order']) ?? existing?.order_index ?? 0;
    const synopsis =
      stringValue(payload, ['synopsis', 'summary', 'description', 'intro']) ?? existing?.synopsis ?? null;
    const contentSize =
      numberValue(payload, ['contentSize', 'content_size', 'wordCount', 'word_count']) ?? existing?.content_size ?? 0;
    const status = stringValue(payload, ['status']) ?? existing?.status ?? 'draft';
    const createdAt = numberValue(payload, ['createdAt', 'created_at']) ?? existing?.created_at ?? change.occurredAt;
    const updatedAt = numberValue(payload, ['updatedAt', 'updated_at']) ?? existing?.updated_at ?? change.occurredAt;

    // A pre-existing document can be updated without repeating its relation;
    // a new document still needs a folder/volume coordinate to be useful.
    if (!folderId) return;
    this.ensureWorkspace(parentWorkspaceId, change.occurredAt);
    this.ensureFolder(folderId, parentWorkspaceId, change.occurredAt);

    this.db
      .prepare(
        `INSERT INTO documents
          (id, folder_id, workspace_id, title, order_index, synopsis, content_size, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           folder_id = excluded.folder_id,
           workspace_id = excluded.workspace_id,
           title = excluded.title,
           order_index = excluded.order_index,
           synopsis = excluded.synopsis,
           content_size = excluded.content_size,
           status = excluded.status,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at`
      )
      .run(id, folderId, parentWorkspaceId, title, orderIndex, synopsis, contentSize, status, createdAt, updatedAt);

    if (hasContentPayload(payload)) {
      this.upsertSnapshot(id, payload, change, contentSize);
    }
  }

  private upsertSnapshot(
    documentId: string,
    payload: JsonRecord,
    change: DomainChange,
    documentContentSize: number
  ): void {
    const existing = this.db.prepare('SELECT * FROM document_snapshots WHERE document_id = ?').get(documentId) as
      | SnapshotRow
      | undefined;
    const contentMarkdown =
      stringValue(payload, ['contentMarkdown', 'content_markdown', 'markdown', 'content', 'text', 'body', 'html']) ??
      existing?.content_markdown ??
      '';
    const contentJson = contentJsonValue(payload, existing?.content_json);
    const version =
      numberValue(payload, ['version', 'snapshotVersion', 'snapshot_version', 'revision']) ??
      change.revision ??
      existing?.version ??
      1;
    const contentSize =
      numberValue(payload, ['contentSize', 'content_size', 'wordCount', 'word_count']) ??
      documentContentSize ??
      contentMarkdown.length;
    const updatedAt = numberValue(payload, ['updatedAt', 'updated_at']) ?? change.occurredAt;

    this.db
      .prepare(
        `INSERT INTO document_snapshots
          (document_id, version, content_json, content_markdown, content_size, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(document_id) DO UPDATE SET
           version = excluded.version,
           content_json = excluded.content_json,
           content_markdown = excluded.content_markdown,
           content_size = excluded.content_size,
           updated_at = excluded.updated_at`
      )
      .run(documentId, version, contentJson, contentMarkdown, contentSize, updatedAt);
  }

  private deleteWorkspace(workspaceId: string): void {
    const documentFilter = `
      SELECT d.id
      FROM documents d
      LEFT JOIN folders f ON f.id = d.folder_id
      WHERE d.workspace_id = ? OR f.workspace_id = ?`;

    // Delete dependent rows explicitly even when SQLite foreign keys are
    // enabled by the caller. This also keeps the operation order obvious.
    this.db
      .prepare(
        `DELETE FROM branch_tips
         WHERE document_id IN (${documentFilter})
            OR lane_id IN (SELECT id FROM lanes WHERE workspace_id = ?)`
      )
      .run(workspaceId, workspaceId, workspaceId);
    this.db
      .prepare(`DELETE FROM document_deltas WHERE document_id IN (${documentFilter})`)
      .run(workspaceId, workspaceId);
    this.db
      .prepare(`DELETE FROM document_snapshots WHERE document_id IN (${documentFilter})`)
      .run(workspaceId, workspaceId);
    this.db.prepare(`DELETE FROM documents WHERE id IN (${documentFilter})`).run(workspaceId, workspaceId);
    this.db.prepare('DELETE FROM folders WHERE workspace_id = ?').run(workspaceId);
    this.db.prepare('DELETE FROM lanes WHERE workspace_id = ?').run(workspaceId);
    this.db.prepare('DELETE FROM workspaces WHERE id = ?').run(workspaceId);
  }

  private deleteFolder(folderId: string): void {
    const documentFilter = 'SELECT id FROM documents WHERE folder_id = ?';
    this.db.prepare(`DELETE FROM branch_tips WHERE document_id IN (${documentFilter})`).run(folderId);
    this.db.prepare(`DELETE FROM document_deltas WHERE document_id IN (${documentFilter})`).run(folderId);
    this.db.prepare(`DELETE FROM document_snapshots WHERE document_id IN (${documentFilter})`).run(folderId);
    this.db.prepare('DELETE FROM documents WHERE folder_id = ?').run(folderId);
    this.db.prepare('DELETE FROM folders WHERE id = ?').run(folderId);
  }

  private deleteDocument(documentId: string): void {
    this.db.prepare('DELETE FROM branch_tips WHERE document_id = ?').run(documentId);
    this.db.prepare('DELETE FROM document_deltas WHERE document_id = ?').run(documentId);
    this.db.prepare('DELETE FROM document_snapshots WHERE document_id = ?').run(documentId);
    this.db.prepare('DELETE FROM documents WHERE id = ?').run(documentId);
  }

  private ensureWorkspace(workspaceId: string, occurredAt: number): void {
    this.db
      .prepare(
        `INSERT INTO workspaces
          (id, title, owner, category, target_size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(workspaceId, workspaceId, '', 'general', 0, occurredAt, occurredAt);
  }

  private ensureFolder(folderId: string, workspaceId: string, occurredAt: number): void {
    this.db
      .prepare(
        `INSERT INTO folders
          (id, workspace_id, title, order_index, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`
      )
      .run(folderId, workspaceId, folderId, 0, occurredAt, occurredAt);
  }
}

/** Alias kept explicit for callers that think in terms of projections. */
export { DomainMaterializer as DomainProjectionMaterializer };

function asRecord(payload: unknown): JsonRecord {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  return payload as JsonRecord;
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function stringValue(record: JsonRecord, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    if (typeof record[key] === 'string') return record[key] as string;
  }
  return undefined;
}

function numberValue(record: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function metadataValue(record: JsonRecord, existing: string | null | undefined): string | null {
  if (hasOwn(record, 'metadata')) return jsonString(record.metadata);
  if (hasOwn(record, 'projectType') || hasOwn(record, 'project_type') || hasOwn(record, 'features')) {
    const desktopMetadata: JsonRecord = {};
    const projectType = record.projectType ?? record.project_type;
    if (projectType !== undefined) desktopMetadata.projectType = projectType;
    if (record.features !== undefined) desktopMetadata.features = record.features;
    return JSON.stringify(desktopMetadata);
  }
  return existing ?? null;
}

function contentJsonValue(record: JsonRecord, existing: string | null | undefined): string {
  for (const key of ['contentJson', 'content_json', 'contentAst', 'content_ast']) {
    if (!hasOwn(record, key)) continue;
    const value = record[key];
    if (typeof value === 'string') return value;
    if (value !== undefined) return JSON.stringify(value);
  }
  return existing ?? '{}';
}

function jsonString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function hasContentPayload(record: JsonRecord): boolean {
  return [
    'contentJson',
    'content_json',
    'contentAst',
    'content_ast',
    'contentMarkdown',
    'content_markdown',
    'markdown',
    'content',
    'text',
    'body',
    'html'
  ].some((key) => hasOwn(record, key));
}

function normalizeAggregateType(value: string): 'workspace' | 'folder' | 'document' | 'unknown' {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[\s_-]/g, '');
  if (
    normalized === 'project' ||
    normalized === 'projects' ||
    normalized === 'workspace' ||
    normalized === 'workspaces'
  ) {
    return 'workspace';
  }
  if (normalized === 'volume' || normalized === 'volumes' || normalized === 'folder' || normalized === 'folders') {
    return 'folder';
  }
  if (
    normalized === 'chapter' ||
    normalized === 'chapters' ||
    normalized === 'document' ||
    normalized === 'documents'
  ) {
    return 'document';
  }
  return 'unknown';
}

function orderChangesForForeignKeys(changes: readonly DomainChange[]): DomainChange[] {
  return changes
    .map((change, index) => ({ change, index }))
    .sort((left, right) => {
      const leftRank = materializationRank(left.change);
      const rightRank = materializationRank(right.change);
      return leftRank - rightRank || left.index - right.index;
    })
    .map(({ change }) => change);
}

function materializationRank(change: DomainChange): number {
  const aggregate = normalizeAggregateType(change.aggregateType);
  const rank = aggregate === 'workspace' ? 0 : aggregate === 'folder' ? 1 : aggregate === 'document' ? 2 : 3;
  return change.operation === 'delete' ? 10 - rank : rank;
}

function assertGenericProjectionCoordinate(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Generic domain projection ${label} must be a non-empty string`);
  }
}

function serializeProjectionPayload(payload: unknown): string {
  try {
    const serialized = JSON.stringify(payload, (_key, value: unknown) => (value === undefined ? null : value));
    return serialized === undefined ? 'null' : serialized;
  } catch {
    throw new Error('Generic domain projection payload must be JSON serializable');
  }
}

function parseGenericProjection(row: GenericDomainProjectionRow): GenericDomainProjection {
  const workspaceId = String(row.workspace_id);
  const aggregateType = String(row.aggregate_type);
  const aggregateId = String(row.aggregate_id);
  assertGenericProjectionCoordinate(workspaceId, 'workspace');
  assertGenericProjectionCoordinate(aggregateType, 'aggregate type');
  assertGenericProjectionCoordinate(aggregateId, 'aggregate id');
  const payloadJson = String(row.payload_json);
  let payload: unknown;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    throw new Error(`Corrupt generic domain projection payload: ${aggregateType}/${aggregateId}`);
  }
  const payloadHash = String(row.payload_hash);
  if (calculatePayloadHash(payloadJson) !== payloadHash) {
    throw new Error(`Generic domain projection payload hash mismatch: ${aggregateType}/${aggregateId}`);
  }
  return {
    workspaceId,
    aggregateType,
    aggregateId,
    revision: Number(row.revision),
    payload,
    payloadHash,
    updatedAt: Number(row.updated_at)
  };
}

function calculatePayloadHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}
