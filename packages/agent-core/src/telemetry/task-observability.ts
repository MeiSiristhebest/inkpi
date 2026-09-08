import type { AiTask, TaskStatus } from '@inkpi/protocol';
import type { ContextPacket } from '../context/types.js';

export interface TaskRunObservation {
  taskId: string;
  kind: string;
  executionRunId?: string;
  status: TaskStatus;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
  progress?: number;
  contextFingerprint?: string;
  contextSources?: string[];
  contextTokenCount?: number;
  projectRevision?: number;
  instructionId?: string;
  routeId?: string;
  instructionVersion?: string;
  skillIds?: string[];
  skillVersions?: Record<string, string>;
  provider?: string;
  model?: string;
  latencyMs?: number;
  usage?: Record<string, unknown>;
  cache?: Record<string, unknown>;
  tools?: string[];
  resultType?: string;
  artifactIds?: string[];
  proposalIds?: string[];
  checkpointIds?: string[];
  checkpoint?: { step: string; updatedAt: number };
  error?: { code?: string; message?: string };
  provenance: Record<string, unknown>;
}

export interface TaskRunObserver {
  started?(task: AiTask): void;
  contextBuilt?(task: AiTask, context: ContextPacket): void;
  progress?(task: AiTask, progress: number): void;
  finished?(task: AiTask, observation: TaskRunObservation): void;
}

export class TaskObservability implements TaskRunObserver {
  private readonly observations = new Map<string, TaskRunObservation>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  started(task: AiTask): void {
    const metadata = task.metadata ?? {};
    this.observations.set(task.id, {
      taskId: task.id,
      kind: task.kind,
      executionRunId: typeof metadata.executionRunId === 'string' ? metadata.executionRunId : undefined,
      status: 'running',
      startedAt: this.now(),
      provenance: {
        taskId: task.id,
        taskKind: task.kind,
        createdAt: this.now(),
      },
    });
    const observation = this.require(task.id);
    if (typeof metadata.instructionVersion === 'string') observation.instructionVersion = metadata.instructionVersion;
    if (typeof metadata.instructionId === 'string') observation.instructionId = metadata.instructionId;
    if (Array.isArray(metadata.skillIds)) observation.skillIds = metadata.skillIds.filter((id): id is string => typeof id === 'string');
    if (metadata.skillVersions && typeof metadata.skillVersions === 'object') {
      observation.skillVersions = { ...(metadata.skillVersions as Record<string, string>) };
    }
    if (typeof metadata.routeId === 'string') observation.routeId = metadata.routeId;
    if (typeof metadata.provider === 'string') observation.provider = metadata.provider;
    if (typeof metadata.model === 'string') observation.model = metadata.model;
  }

  contextBuilt(task: AiTask, context: ContextPacket): void {
    const observation = this.require(task.id);
    observation.contextFingerprint = context.fingerprint;
    observation.contextSources = context.fragments.map((fragment) => fragment.source);
    observation.contextTokenCount = context.tokenEstimate;
    observation.projectRevision = task.input.selection?.revision;
    observation.provenance.contextFingerprint = context.fingerprint;
    observation.provenance.contextFragmentIds = context.fragments.map((fragment) => fragment.id);
  }

  progress(task: AiTask, progress: number): void {
    const observation = this.require(task.id);
    observation.progress = progress;
  }

  finished(task: AiTask, observation: TaskRunObservation): void {
    const existing = this.observations.get(task.id) ?? {
      taskId: task.id,
      kind: task.kind,
      status: observation.status,
      provenance: { taskId: task.id, taskKind: task.kind },
    };
    const startedAt = existing.startedAt ?? observation.startedAt;
    const finishedAt = observation.finishedAt ?? this.now();
    this.observations.set(task.id, {
      ...existing,
      ...observation,
      startedAt,
      finishedAt,
      durationMs: startedAt === undefined ? undefined : Math.max(0, finishedAt - startedAt),
      provenance: { ...existing.provenance, ...observation.provenance },
    });
    const stored = this.observations.get(task.id);
    if (stored && observation.resultType === undefined) {
      stored.resultType = observation.provenance.resultType as string | undefined;
    }
  }

  get(taskId: string): TaskRunObservation | undefined {
    const observation = this.observations.get(taskId);
    return observation ? cloneObservation(observation) : undefined;
  }

  list(): TaskRunObservation[] {
    return [...this.observations.values()].map(cloneObservation);
  }

  private require(taskId: string): TaskRunObservation {
    const observation = this.observations.get(taskId);
    if (!observation) throw new Error(`Task observation has not started: ${taskId}`);
    return observation;
  }
}

function cloneObservation(observation: TaskRunObservation): TaskRunObservation {
  return { ...observation, provenance: { ...observation.provenance } };
}
