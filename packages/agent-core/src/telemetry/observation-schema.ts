import type { TaskStatus } from '@inkpi/protocol';
import { sanitizeTelemetryData } from './private-data.js';
import type { TaskRunObservation } from './task-observability.js';

export const TASK_OBSERVATION_SCHEMA = 'inkpi.task-observation' as const;
export const TASK_OBSERVATION_SCHEMA_VERSION = 1 as const;
export const TASK_OBSERVATION_EVENT_TYPE = 'task_observation' as const;

const TASK_STATUSES = new Set<TaskStatus>([
  'created',
  'queued',
  'running',
  'checkpointed',
  'waiting-user',
  'interrupted',
  'completed',
  'failed',
  'cancelled'
]);

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_ERROR_MESSAGE_LENGTH = 2048;
const MAX_ARRAY_ITEMS = 256;

export type PersistedTaskObservation = TaskRunObservation & {
  schema: typeof TASK_OBSERVATION_SCHEMA;
  schemaVersion: typeof TASK_OBSERVATION_SCHEMA_VERSION;
  eventType: typeof TASK_OBSERVATION_EVENT_TYPE;
  observedAt: number;
};

export class ObservationSchemaError extends Error {
  readonly code = 'OBSERVATION_SCHEMA_INVALID' as const;

  constructor(field: string) {
    super(`Invalid task observation schema field: ${field}`);
    this.name = 'ObservationSchemaError';
  }
}

/**
 * Convert a task observation into the versioned, JSON-safe record written by
 * the server sink. Unknown top-level fields are intentionally not copied.
 */
export function toPersistedTaskObservation(
  observation: TaskRunObservation,
  now: () => number = Date.now
): PersistedTaskObservation {
  const safe = sanitizeTelemetryData(observation) as unknown;
  if (!isRecord(safe)) throw invalid('observation');

  const taskId = requiredString(safe.taskId, 'taskId');
  const kind = requiredString(safe.kind, 'kind');
  const status = safe.status;
  if (typeof status !== 'string' || !TASK_STATUSES.has(status as TaskStatus)) throw invalid('status');

  const provenance = requiredRecord(safe.provenance, 'provenance');
  assertJsonRecord(provenance, 'provenance');

  const observedAt = safe.finishedAt ?? safe.startedAt ?? now();
  if (!isFiniteNonNegativeNumber(observedAt)) throw invalid('observedAt');

  const record: Record<string, unknown> = {
    schema: TASK_OBSERVATION_SCHEMA,
    schemaVersion: TASK_OBSERVATION_SCHEMA_VERSION,
    eventType: TASK_OBSERVATION_EVENT_TYPE,
    observedAt,
    taskId,
    kind,
    status,
    provenance
  };

  copyOptionalString(record, safe, 'executionRunId');
  copyOptionalNonNegativeInteger(record, safe, 'attempt');
  copyOptionalNonNegativeNumber(record, safe, 'startedAt');
  copyOptionalNonNegativeNumber(record, safe, 'finishedAt');
  copyOptionalNonNegativeNumber(record, safe, 'durationMs');
  copyOptionalProgress(record, safe);
  copyOptionalString(record, safe, 'contextFingerprint');
  copyOptionalStringArray(record, safe, 'contextSources');
  copyOptionalNonNegativeInteger(record, safe, 'contextTokenCount');
  copyOptionalNonNegativeInteger(record, safe, 'projectRevision');
  copyOptionalString(record, safe, 'instructionId');
  copyOptionalString(record, safe, 'routeId');
  copyOptionalString(record, safe, 'instructionVersion');
  copyOptionalStringArray(record, safe, 'skillIds');
  copyOptionalStringRecord(record, safe, 'skillVersions');
  copyOptionalString(record, safe, 'provider');
  copyOptionalString(record, safe, 'model');
  copyOptionalNonNegativeNumber(record, safe, 'latencyMs');
  copyOptionalJsonRecord(record, safe, 'usage');
  copyOptionalJsonRecord(record, safe, 'cache');
  copyOptionalStringArray(record, safe, 'tools');
  copyOptionalString(record, safe, 'resultType');
  copyOptionalStringArray(record, safe, 'artifactIds');
  copyOptionalStringArray(record, safe, 'proposalIds');
  copyOptionalStringArray(record, safe, 'checkpointIds');
  copyOptionalCheckpoint(record, safe);
  copyOptionalError(record, safe);

  if (record.attempt === undefined && provenance.executionAttempt !== undefined) {
    record.attempt = optionalNonNegativeInteger(provenance.executionAttempt, 'provenance.executionAttempt');
  }
  if (record.executionRunId === undefined && provenance.executionRunId !== undefined) {
    record.executionRunId = optionalString(provenance.executionRunId, 'provenance.executionRunId');
  }

  const persisted = record as unknown as PersistedTaskObservation;
  if (!isTaskObservationRecord(persisted)) throw invalid('record');
  return persisted;
}

/** Runtime guard for records read from the JSONL sink. */
export function isTaskObservationRecord(value: unknown): value is PersistedTaskObservation {
  if (!isRecord(value)) return false;
  if (value.schema !== TASK_OBSERVATION_SCHEMA) return false;
  if (value.schemaVersion !== TASK_OBSERVATION_SCHEMA_VERSION) return false;
  if (value.eventType !== TASK_OBSERVATION_EVENT_TYPE) return false;
  if (!isFiniteNonNegativeNumber(value.observedAt)) return false;
  if (typeof value.taskId !== 'string' || value.taskId.length === 0) return false;
  if (typeof value.kind !== 'string' || value.kind.length === 0) return false;
  if (typeof value.status !== 'string' || !TASK_STATUSES.has(value.status as TaskStatus)) return false;
  if (!isRecord(value.provenance)) return false;
  return true;
}

function copyOptionalString(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (source[key] === undefined) return;
  target[key] = optionalString(source[key], key);
}

function copyOptionalStringArray(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (source[key] === undefined) return;
  const value = source[key];
  if (!Array.isArray(value) || value.length > MAX_ARRAY_ITEMS) throw invalid(key);
  if (value.some((item) => typeof item !== 'string' || item.length > MAX_IDENTIFIER_LENGTH)) throw invalid(key);
  target[key] = [...value];
}

function copyOptionalStringRecord(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (source[key] === undefined) return;
  target[key] = readStringRecord(source[key], key);
}

function copyOptionalJsonRecord(target: Record<string, unknown>, source: Record<string, unknown>, key: string): void {
  if (source[key] === undefined) return;
  const value = requiredRecord(source[key], key);
  assertJsonRecord(value, key);
  target[key] = value;
}

function copyOptionalNonNegativeNumber(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string
): void {
  if (source[key] === undefined) return;
  target[key] = optionalNonNegativeNumber(source[key], key);
}

function copyOptionalNonNegativeInteger(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string
): void {
  if (source[key] === undefined) return;
  target[key] = optionalNonNegativeInteger(source[key], key);
}

function copyOptionalProgress(target: Record<string, unknown>, source: Record<string, unknown>): void {
  if (source.progress === undefined) return;
  if (
    typeof source.progress !== 'number' ||
    !Number.isFinite(source.progress) ||
    source.progress < 0 ||
    source.progress > 1
  ) {
    throw invalid('progress');
  }
  target.progress = source.progress;
}

function copyOptionalCheckpoint(target: Record<string, unknown>, source: Record<string, unknown>): void {
  if (source.checkpoint === undefined) return;
  const checkpoint = requiredRecord(source.checkpoint, 'checkpoint');
  target.checkpoint = {
    step: requiredString(checkpoint.step, 'checkpoint.step'),
    updatedAt: optionalNonNegativeNumber(checkpoint.updatedAt, 'checkpoint.updatedAt')
  };
}

function copyOptionalError(target: Record<string, unknown>, source: Record<string, unknown>): void {
  if (source.error === undefined) return;
  const error = requiredRecord(source.error, 'error');
  const safeError: Record<string, unknown> = {};
  if (error.code !== undefined) safeError.code = optionalString(error.code, 'error.code');
  if (error.message !== undefined) {
    const message = optionalString(error.message, 'error.message', MAX_ERROR_MESSAGE_LENGTH);
    safeError.message = message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
  }
  if (error.retryable !== undefined) {
    if (typeof error.retryable !== 'boolean') throw invalid('error.retryable');
    safeError.retryable = error.retryable;
  }
  target.error = safeError;
}

function requiredString(value: unknown, field: string): string {
  const result = optionalString(value, field);
  if (!result.trim()) throw invalid(field);
  return result;
}

function optionalString(value: unknown, field: string, maxLength = MAX_IDENTIFIER_LENGTH): string {
  if (typeof value !== 'string' || value.length > maxLength) throw invalid(field);
  return value;
}

function optionalNonNegativeNumber(value: unknown, field: string): number {
  if (!isFiniteNonNegativeNumber(value)) throw invalid(field);
  return value;
}

function optionalNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalid(field);
  return value as number;
}

function requiredRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalid(field);
  return value;
}

function readStringRecord(value: unknown, field: string): Record<string, string> {
  const record = requiredRecord(value, field);
  const result: Record<string, string> = {};
  for (const [key, nestedValue] of Object.entries(record)) {
    result[key] = optionalString(nestedValue, `${field}.${key}`);
  }
  return result;
}

function assertJsonRecord(value: Record<string, unknown>, field: string): void {
  for (const [key, nestedValue] of Object.entries(value)) {
    assertJsonValue(nestedValue, `${field}.${key}`);
  }
}

function assertJsonValue(value: unknown, field: string, depth = 0): void {
  if (depth > 12) throw invalid(field);
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(field);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARRAY_ITEMS) throw invalid(field);
    value.forEach((item, index) => assertJsonValue(item, `${field}[${index}]`, depth + 1));
    return;
  }
  if (isRecord(value)) {
    for (const [key, nestedValue] of Object.entries(value)) {
      assertJsonValue(nestedValue, `${field}.${key}`, depth + 1);
    }
    return;
  }
  throw invalid(field);
}

function isFiniteNonNegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function invalid(field: string): ObservationSchemaError {
  return new ObservationSchemaError(field);
}
