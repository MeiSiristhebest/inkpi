import type { Artifact, ArtifactStore } from '@inkpi/protocol';
import type { IDb } from './ports.js';

export class ArtifactConflictError extends Error {
  readonly code = 'ARTIFACT_CONFLICT';

  constructor(readonly artifactId: string) {
    super(`Artifact ${artifactId} already exists with incompatible content`);
    this.name = 'ArtifactConflictError';
  }
}

/** SQLite adapter for Runtime artifacts. Values are cloned at both boundaries. */
export class SqliteArtifactStore implements ArtifactStore {
  constructor(private readonly db: IDb) {}

  save(artifact: Artifact): void {
    validateArtifact(artifact);
    const serialized = JSON.stringify(artifact);
    const provenance = artifact.provenance ?? {};
    this.db.transaction(() => {
      const existingRow = this.db.prepare('SELECT artifact_json FROM artifacts WHERE id = ?').get(artifact.id) as
        | { artifact_json: string }
        | undefined;
      if (existingRow) {
        const existing = parseArtifact(existingRow.artifact_json, artifact.id);
        if (stableSerialize(existing) !== stableSerialize(artifact)) throw new ArtifactConflictError(artifact.id);
        return;
      }
      this.db
        .prepare(
          `INSERT INTO artifacts
            (id, type, task_id, version, content_json, provenance_json, created_at, updated_at, artifact_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          artifact.id,
          artifact.type,
          typeof provenance.taskId === 'string' ? provenance.taskId : null,
          artifact.version,
          JSON.stringify(artifact.content),
          JSON.stringify(provenance),
          artifact.createdAt,
          artifact.updatedAt,
          serialized
        );
    });
  }

  get(id: string): Artifact | undefined {
    const row = this.db.prepare('SELECT artifact_json FROM artifacts WHERE id = ?').get(id) as
      | { artifact_json: string }
      | undefined;
    return row ? parseArtifact(row.artifact_json, id) : undefined;
  }

  list(taskId?: string): Artifact[] {
    const rows = (
      taskId
        ? this.db
            .prepare('SELECT id, artifact_json FROM artifacts WHERE task_id = ? ORDER BY created_at, id')
            .all(taskId)
        : this.db.prepare('SELECT id, artifact_json FROM artifacts ORDER BY created_at, id').all()
    ) as Array<{
      id: string;
      artifact_json: string;
    }>;
    return rows.map((row) => parseArtifact(row.artifact_json, row.id));
  }

  listByType(type: string): Artifact[] {
    const rows = this.db
      .prepare('SELECT id, artifact_json FROM artifacts WHERE type = ? ORDER BY created_at, id')
      .all(type) as Array<{ id: string; artifact_json: string }>;
    return rows.map((row) => parseArtifact(row.artifact_json, row.id));
  }
}

function validateArtifact(artifact: Artifact): void {
  if (!artifact.id.trim() || !artifact.type.trim()) throw new Error('Artifact identifiers must not be empty');
  if (!Number.isInteger(artifact.version) || artifact.version < 1) {
    throw new Error('Artifact version must be a positive integer');
  }
  if (!Number.isFinite(artifact.createdAt) || !Number.isFinite(artifact.updatedAt)) {
    throw new Error('Artifact timestamps must be finite');
  }
  if (!artifact.provenance || typeof artifact.provenance !== 'object' || Array.isArray(artifact.provenance)) {
    throw new Error('Artifact provenance must be an object');
  }
}

function parseArtifact(serialized: string, id: string): Artifact {
  try {
    const artifact = JSON.parse(serialized) as Artifact;
    validateArtifact(artifact);
    return cloneValue(artifact);
  } catch (error) {
    throw new Error(`Corrupt artifact '${id}'; refusing to read`, { cause: error });
  }
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableSerialize(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}
