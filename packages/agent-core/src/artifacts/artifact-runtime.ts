import type { AiTask, Artifact, ArtifactStore, TaskOutput, TaskResult } from '@inkpi/protocol';

export interface ArtifactPersistenceOptions {
  type?: string;
  version?: number;
  parentArtifactId?: string;
  sourceRevision?: number;
  sessionId?: string;
  executionRunId?: string;
  idGenerator?: (task: AiTask) => string;
}

/**
 * Turns a durable task result into a semantic Artifact. Persistence is
 * opt-in through the task output contract, and the injected store is the only
 * side effect. This keeps artifact creation separate from domain mutation.
 */
export class ArtifactRuntime {
  private readonly pending = new Map<string, Promise<Artifact>>();

  constructor(
    private readonly store: ArtifactStore,
    private readonly now: () => number = Date.now,
    private readonly idGenerator: (task: AiTask) => string = (task) => `artifact:${task.id}`
  ) {}

  async persistTaskResult(
    task: AiTask,
    result: TaskResult,
    artifactId?: string,
    options: ArtifactPersistenceOptions = {}
  ): Promise<Artifact | undefined> {
    if (result.status !== 'completed' && result.status !== 'waiting-user') return undefined;
    if (!result.output || task.outputContract?.persistence !== 'artifact') return undefined;

    const id = artifactId ?? result.artifactIds?.[0] ?? options.idGenerator?.(task) ?? this.idGenerator(task);
    const resultProvenance = result.provenance ?? {};
    const parentArtifactId =
      options.parentArtifactId ??
      readString(task.metadata, 'parentArtifactId') ??
      readString(resultProvenance, 'parentArtifactId');
    const sourceRevision =
      options.sourceRevision ??
      readNumber(task.metadata, 'sourceRevision') ??
      readNumber(resultProvenance, 'sourceRevision') ??
      task.input.selection?.revision;
    const sessionId =
      options.sessionId ?? readString(task.metadata, 'sessionId') ?? readString(resultProvenance, 'sessionId');
    const executionRunId =
      options.executionRunId ??
      readString(task.metadata, 'executionRunId') ??
      readString(resultProvenance, 'executionRunId');
    const createdAt = this.now();
    const artifact: Artifact = {
      id,
      type:
        options.type ??
        readString(task.metadata, 'artifactType') ??
        task.outputContract.schemaId ??
        `runtime.${task.kind}`,
      version: options.version ?? readNumber(task.metadata, 'artifactVersion') ?? 1,
      content: cloneValue(outputContent(result.output)),
      provenance: {
        ...resultProvenance,
        taskId: task.id,
        ...(executionRunId ? { executionRunId } : {}),
        ...(sessionId ? { sessionId } : {}),
        ...(parentArtifactId ? { parentArtifactId } : {}),
        ...(sourceRevision === undefined ? {} : { sourceRevision })
      },
      createdAt,
      updatedAt: this.now()
    };

    const existingPending = this.pending.get(id);
    if (existingPending) {
      const existing = await existingPending;
      assertCompatibleArtifact(existing, artifact);
      return cloneValue(existing);
    }

    const save = (async () => {
      const existing = await this.store.get(id);
      if (existing) {
        assertCompatibleArtifact(existing, artifact);
        return cloneValue(existing);
      }
      await this.store.save(cloneValue(artifact));
      return artifact;
    })();
    this.pending.set(id, save);
    try {
      return await save;
    } finally {
      if (this.pending.get(id) === save) this.pending.delete(id);
    }
  }
}

function assertCompatibleArtifact(existing: Artifact, candidate: Artifact): void {
  if (stableSerialize(artifactIdentity(existing)) !== stableSerialize(artifactIdentity(candidate))) {
    throw new Error(`Artifact ${candidate.id} is already persisted with incompatible content`);
  }
}

function artifactIdentity(artifact: Artifact): unknown {
  return {
    id: artifact.id,
    type: artifact.type,
    version: artifact.version,
    content: artifact.content,
    provenance: artifact.provenance
  };
}

function outputContent(output: TaskOutput): unknown {
  if (output.format === 'text') return output.text;
  if (output.format === 'structured') return output.data;
  return output.patch;
}

function readString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function readNumber(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
