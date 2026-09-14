import type { AiTask, TaskStatus } from '@inkpi/protocol';
import type { RuntimeCacheStats } from '../context/cache-contract.js';
import type { ContextPacket } from '../context/types.js';
import { sanitizeTelemetryData } from './private-data.js';

export interface TaskRunObservation {
  taskId: string;
  kind: string;
  executionRunId?: string;
  attempt?: number;
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
  error?: { code?: string; message?: string; retryable?: boolean };
  provenance: Record<string, unknown>;
}

export interface TaskObservabilityOptions {
  /** Clock used for observation timestamps and duration calculation. */
  now?: () => number;
  /** Fraction of task runs to retain and emit, normalized to the range 0..1. */
  sampleRate?: number;
  /** Injectable source for deterministic sampling tests. */
  random?: () => number;
  /** Best-effort sink invoked with a sanitized copy of each retained observation. */
  onObservation?: (observation: TaskRunObservation) => void;
  /** Safe health signal emitted when an observation sink fails. It contains no observation data. */
  onObservationError?: (signal: TaskObservationErrorSignal) => void;
}

export interface TaskObservationErrorSignal {
  type: 'observation_sink_error';
  code: 'OBSERVATION_SINK_ERROR';
  at: number;
  consecutiveFailures: number;
}

export interface TaskObservabilityHealth {
  healthy: boolean;
  emitted: number;
  sinkErrors: number;
  consecutiveSinkErrors: number;
  lastErrorAt?: number;
}

export interface TaskRunObserver {
  started?(task: AiTask): void;
  contextBuilt?(task: AiTask, context: ContextPacket, cacheStats?: RuntimeCacheStats): void;
  progress?(task: AiTask, progress: number): void;
  finished?(task: AiTask, observation: TaskRunObservation): void;
}

export class TaskObservability implements TaskRunObserver {
  private readonly observations = new Map<string, TaskRunObservation>();
  private readonly sampleDecisions = new Map<string, boolean>();
  private readonly now: () => number;
  private readonly sampleRate: number;
  private readonly random: () => number;
  private readonly onObservation?: (observation: TaskRunObservation) => void;
  private readonly onObservationError?: (signal: TaskObservationErrorSignal) => void;
  private emitted = 0;
  private sinkErrors = 0;
  private consecutiveSinkErrors = 0;
  private lastErrorAt?: number;

  constructor(options: TaskObservabilityOptions | (() => number) = {}) {
    const normalized = typeof options === 'function' ? {} : options;
    this.now = typeof options === 'function' ? options : (normalized.now ?? Date.now);
    this.sampleRate = normalizeSampleRate(normalized.sampleRate);
    this.random = normalized.random ?? Math.random;
    this.onObservation = normalized.onObservation;
    this.onObservationError = normalized.onObservationError;
  }

  started(task: AiTask): void {
    if (!this.shouldSample(task)) return;
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
        createdAt: this.now()
      }
    });
    const observation = this.require(task.id);
    if (typeof metadata.instructionVersion === 'string') observation.instructionVersion = metadata.instructionVersion;
    if (typeof metadata.instructionId === 'string') observation.instructionId = metadata.instructionId;
    if (Array.isArray(metadata.skillIds))
      observation.skillIds = metadata.skillIds.filter((id): id is string => typeof id === 'string');
    if (metadata.skillVersions && typeof metadata.skillVersions === 'object') {
      observation.skillVersions = { ...(metadata.skillVersions as Record<string, string>) };
    }
    if (typeof metadata.routeId === 'string') observation.routeId = metadata.routeId;
    if (typeof metadata.provider === 'string') observation.provider = metadata.provider;
    if (typeof metadata.model === 'string') observation.model = metadata.model;
  }

  contextBuilt(task: AiTask, context: ContextPacket, cacheStats?: RuntimeCacheStats): void {
    if (!this.shouldSample(task)) return;
    const observation = this.require(task.id);
    observation.contextFingerprint = context.fingerprint;
    observation.contextSources = context.fragments.map((fragment) => fragment.source);
    observation.contextTokenCount = context.tokenEstimate;
    observation.projectRevision =
      context.projectRevision ?? task.input.selection?.revision ?? readProjectRevision(task.metadata);
    if (cacheStats) {
      observation.cache = {
        provider: { ...cacheStats.provider },
        context: { ...cacheStats.context },
        retrieval: { ...cacheStats.retrieval }
      };
    }
    observation.provenance.contextFingerprint = context.fingerprint;
    observation.provenance.contextFragmentIds = context.fragments.map((fragment) => fragment.id);
  }

  progress(task: AiTask, progress: number): void {
    if (!this.shouldSample(task)) return;
    const observation = this.require(task.id);
    observation.progress = progress;
  }

  finished(task: AiTask, observation: TaskRunObservation): void {
    if (!this.shouldSample(task)) {
      this.sampleDecisions.delete(task.id);
      return;
    }
    const safeObservation = withInstructionSkillProvenance(sanitizeObservation(observation));
    const existing = this.observations.get(task.id) ?? {
      taskId: task.id,
      kind: task.kind,
      status: safeObservation.status,
      provenance: { taskId: task.id, taskKind: task.kind }
    };
    const startedAt = existing.startedAt ?? safeObservation.startedAt;
    const finishedAt = safeObservation.finishedAt ?? this.now();
    this.observations.set(task.id, {
      ...existing,
      ...safeObservation,
      startedAt,
      finishedAt,
      durationMs: startedAt === undefined ? undefined : Math.max(0, finishedAt - startedAt),
      error: safeObservation.error,
      provenance: { ...existing.provenance, ...safeObservation.provenance }
    });
    const stored = this.observations.get(task.id);
    if (stored && safeObservation.resultType === undefined) {
      stored.resultType = safeObservation.provenance.resultType as string | undefined;
    }
    if (stored && this.onObservation) {
      try {
        this.onObservation(cloneObservation(stored));
        this.emitted += 1;
        this.consecutiveSinkErrors = 0;
      } catch {
        // Telemetry sinks must not change task success/failure semantics.
        this.sinkErrors += 1;
        this.consecutiveSinkErrors += 1;
        const errorAt = safeNow(this.now);
        this.lastErrorAt = errorAt;
        try {
          this.onObservationError?.({
            type: 'observation_sink_error',
            code: 'OBSERVATION_SINK_ERROR',
            at: errorAt,
            consecutiveFailures: this.consecutiveSinkErrors
          });
        } catch {
          // Health callbacks are best effort as well.
        }
      }
    }
    this.sampleDecisions.delete(task.id);
  }

  getHealth(): TaskObservabilityHealth {
    return {
      healthy: this.consecutiveSinkErrors === 0,
      emitted: this.emitted,
      sinkErrors: this.sinkErrors,
      consecutiveSinkErrors: this.consecutiveSinkErrors,
      lastErrorAt: this.lastErrorAt
    };
  }

  get(taskId: string): TaskRunObservation | undefined {
    const observation = this.observations.get(taskId);
    return observation ? cloneObservation(observation) : undefined;
  }

  list(): TaskRunObservation[] {
    return [...this.observations.values()].map(cloneObservation);
  }

  private shouldSample(task: AiTask): boolean {
    const existing = this.sampleDecisions.get(task.id);
    if (existing !== undefined) return existing;
    const sampled = this.random() < this.sampleRate;
    this.sampleDecisions.set(task.id, sampled);
    return sampled;
  }

  private require(taskId: string): TaskRunObservation {
    const observation = this.observations.get(taskId);
    if (!observation) throw new Error(`Task observation has not started: ${taskId}`);
    return observation;
  }
}

function readProjectRevision(metadata: Record<string, unknown> | undefined): number | undefined {
  const revision = metadata?.projectRevision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
}

function cloneObservation(observation: TaskRunObservation): TaskRunObservation {
  return sanitizeObservation(observation);
}

function sanitizeObservation(observation: TaskRunObservation): TaskRunObservation {
  return sanitizeTelemetryData(observation);
}

function withInstructionSkillProvenance(observation: TaskRunObservation): TaskRunObservation {
  const references = observation.provenance.instructionProvenance;
  if (!Array.isArray(references)) return observation;

  const skillIds = new Set(observation.skillIds ?? []);
  const skillVersions: Record<string, string> = { ...(observation.skillVersions ?? {}) };
  for (const reference of references) {
    if (!reference || typeof reference !== 'object') continue;
    const provenance = (reference as { provenance?: unknown }).provenance;
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) continue;
    const skillId = (provenance as { skillId?: unknown }).skillId;
    if (typeof skillId !== 'string' || !skillId.trim()) continue;
    skillIds.add(skillId);
    const skillVersion = (provenance as { skillVersion?: unknown }).skillVersion;
    if (typeof skillVersion === 'string' && skillVersion.trim()) skillVersions[skillId] = skillVersion;
  }

  if (skillIds.size === 0) return observation;
  return {
    ...observation,
    skillIds: [...skillIds].sort(),
    skillVersions: Object.keys(skillVersions).length > 0 ? skillVersions : undefined
  };
}

function normalizeSampleRate(sampleRate: number | undefined): number {
  if (sampleRate === undefined || !Number.isFinite(sampleRate)) return 1;
  return Math.min(1, Math.max(0, sampleRate));
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}
