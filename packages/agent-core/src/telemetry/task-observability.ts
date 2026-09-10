import type { AiTask, TaskStatus } from '@inkpi/protocol';
import type { RuntimeCacheStats } from '../context/cache-contract.js';
import type { ContextPacket } from '../context/types.js';
import { stripPrivateReasoningText } from './private-data.js';

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

export interface TaskObservabilityOptions {
  /** Clock used for observation timestamps and duration calculation. */
  now?: () => number;
  /** Fraction of task runs to retain and emit, normalized to the range 0..1. */
  sampleRate?: number;
  /** Injectable source for deterministic sampling tests. */
  random?: () => number;
  /** Best-effort sink invoked with a sanitized copy of each retained observation. */
  onObservation?: (observation: TaskRunObservation) => void;
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

  constructor(options: TaskObservabilityOptions | (() => number) = {}) {
    const normalized = typeof options === 'function' ? {} : options;
    this.now = typeof options === 'function' ? options : normalized.now ?? Date.now;
    this.sampleRate = normalizeSampleRate(normalized.sampleRate);
    this.random = normalized.random ?? Math.random;
    this.onObservation = normalized.onObservation;
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
    observation.projectRevision = task.input.selection?.revision;
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
    const safeObservation = sanitizeObservation(observation);
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
      provenance: { ...existing.provenance, ...safeObservation.provenance }
    });
    const stored = this.observations.get(task.id);
    if (stored && safeObservation.resultType === undefined) {
      stored.resultType = safeObservation.provenance.resultType as string | undefined;
    }
    if (stored && this.onObservation) {
      try {
        this.onObservation(cloneObservation(stored));
      } catch {
        // Telemetry sinks must not change task success/failure semantics.
      }
    }
    this.sampleDecisions.delete(task.id);
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

function cloneObservation(observation: TaskRunObservation): TaskRunObservation {
  return sanitizeObservation(observation);
}

function sanitizeObservation(observation: TaskRunObservation): TaskRunObservation {
  return sanitizePublicValue(observation) as TaskRunObservation;
}

function sanitizePublicValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return stripPrivateReasoningText(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => sanitizePublicValue(item, seen));
    if (value instanceof Date) return new Date(value.getTime());
    const safe: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (PRIVATE_REASONING_KEYS.has(normalizePrivateKey(key))) continue;
      safe[key] = sanitizePublicValue(nestedValue, seen);
    }
    return safe;
  } finally {
    seen.delete(value);
  }
}

function normalizePrivateKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function normalizeSampleRate(sampleRate: number | undefined): number {
  if (sampleRate === undefined || !Number.isFinite(sampleRate)) return 1;
  return Math.min(1, Math.max(0, sampleRate));
}

const PRIVATE_REASONING_KEYS = new Set([
  'thinking',
  'reasoning',
  'reasoningcontent',
  'chainofthought',
  'cot',
  'rawthinking',
  'rawcot'
]);
