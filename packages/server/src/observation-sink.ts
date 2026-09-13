import { randomUUID } from 'node:crypto';
import { constants, closeSync, fchmodSync, openSync, renameSync, statSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ObservationSchemaError,
  type TaskRunObservation,
  sanitizeTelemetryData,
  toPersistedTaskObservation
} from '@inkpi/agent-core';
import { readObservationSinkConfig } from './observability-config.js';

/** A sink that enforces the observation privacy boundary before persistence. */
export type TaskObservationSink = (observation: TaskRunObservation) => void;

export interface JsonlObservationSinkOptions {
  /** Rotate before an append would exceed this many bytes. Disabled when omitted. */
  maxBytes?: number;
  /** Reject a single record larger than this UTF-8 byte size. */
  maxRecordBytes?: number;
  /** Owner-only POSIX mode used when creating and updating the file. */
  fileMode?: number;
  /** Injectable clock used for record timestamps and rotated file names. */
  now?: () => number;
}

export interface JsonlObservationSinkHealth {
  healthy: boolean;
  recordsWritten: number;
  rotations: number;
  writeErrors: number;
  consecutiveErrors: number;
  lastErrorAt?: number;
}

export type ObservationSinkErrorCode =
  | 'OBSERVATION_SCHEMA_INVALID'
  | 'OBSERVATION_RECORD_TOO_LARGE'
  | 'OBSERVATION_ROTATION_FAILED'
  | 'OBSERVATION_WRITE_FAILED';

export class ObservationSinkError extends Error {
  constructor(
    readonly code: ObservationSinkErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ObservationSinkError';
  }
}

export interface JsonlObservationSink extends TaskObservationSink {
  getHealth(): JsonlObservationSinkHealth;
}

const DEFAULT_MAX_RECORD_BYTES = 256 * 1024;
const OWNER_ONLY_MODE_MASK = 0o077;
const OWNER_WRITE_MODE = 0o200;

/**
 * Create a versioned JSONL sink for production task observations.
 *
 * Each record is sanitized and schema-checked before persistence. The record
 * is written with one O_APPEND write, so records from synchronous callers do
 * not share a mutable file descriptor or interleave their JSON bytes. Size
 * rotation is opt-in and renames old segments without deleting them; log
 * retention remains an operator-owned policy.
 */
export function createJsonlObservationSink(
  filePath: string,
  options: JsonlObservationSinkOptions = {}
): JsonlObservationSink {
  const normalizedPath = filePath.trim();
  if (!normalizedPath || normalizedPath.includes('\0')) {
    throw new Error('Observation sink file path must not be empty or contain NUL bytes');
  }

  const absolutePath = resolve(normalizedPath);
  const environmentConfig = readObservationSinkConfig();
  const maxBytes = readPositiveInteger(options.maxBytes ?? environmentConfig.maxBytes, 'maxBytes');
  const maxRecordBytes =
    readPositiveInteger(
      options.maxRecordBytes ?? environmentConfig.maxRecordBytes ?? DEFAULT_MAX_RECORD_BYTES,
      'maxRecordBytes'
    ) ?? DEFAULT_MAX_RECORD_BYTES;
  const fileMode = readOwnerOnlyFileMode(options.fileMode ?? 0o600);
  const now = options.now ?? Date.now;
  let rotationSequence = 0;
  const health = {
    recordsWritten: 0,
    rotations: 0,
    writeErrors: 0,
    consecutiveErrors: 0,
    lastErrorAt: undefined as number | undefined
  };

  const sink = ((observation: TaskRunObservation) => {
    try {
      const record = toPersistedTaskObservation(observation, now);
      const serialized = JSON.stringify(sanitizeTelemetryData(record));
      const payload = Buffer.from(`${serialized}\n`, 'utf8');
      if (payload.byteLength > maxRecordBytes) {
        throw new ObservationSinkError(
          'OBSERVATION_RECORD_TOO_LARGE',
          'Observation record exceeds the configured byte limit.'
        );
      }

      if (maxBytes !== undefined && shouldRotate(absolutePath, payload.byteLength, maxBytes)) {
        rotate(absolutePath, now, rotationSequence++);
        health.rotations += 1;
      }
      appendAtomically(absolutePath, payload, fileMode);
      health.recordsWritten += 1;
      health.consecutiveErrors = 0;
    } catch (error) {
      health.writeErrors += 1;
      health.consecutiveErrors += 1;
      health.lastErrorAt = safeNow(now);
      throw normalizeSinkError(error);
    }
  }) as JsonlObservationSink;

  sink.getHealth = () => ({
    healthy: health.consecutiveErrors === 0,
    recordsWritten: health.recordsWritten,
    rotations: health.rotations,
    writeErrors: health.writeErrors,
    consecutiveErrors: health.consecutiveErrors,
    lastErrorAt: health.lastErrorAt
  });
  return sink;
}

function appendAtomically(filePath: string, payload: Buffer, fileMode: number): void {
  const descriptor = openSync(filePath, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, fileMode);
  try {
    enforceFileMode(descriptor, fileMode);
    const bytesWritten = writeSync(descriptor, payload, 0, payload.byteLength, null);
    if (bytesWritten !== payload.byteLength) {
      throw new ObservationSinkError('OBSERVATION_WRITE_FAILED', 'Observation sink wrote a partial record.');
    }
  } finally {
    closeSync(descriptor);
  }
}

function enforceFileMode(descriptor: number, fileMode: number): void {
  try {
    fchmodSync(descriptor, fileMode);
  } catch (error) {
    // Windows ACLs are managed by the host and fchmod is not a reliable
    // enforcement mechanism there. POSIX failures remain write failures.
    if (process.platform !== 'win32') {
      throw new ObservationSinkError('OBSERVATION_WRITE_FAILED', 'Observation sink permissions could not be set.', {
        cause: error
      });
    }
  }
}

function shouldRotate(filePath: string, additionalBytes: number, maxBytes: number): boolean {
  let currentBytes = 0;
  try {
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      throw new ObservationSinkError('OBSERVATION_ROTATION_FAILED', 'Observation sink path is not a regular file.');
    }
    currentBytes = stats.size;
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false;
    throw new ObservationSinkError('OBSERVATION_ROTATION_FAILED', 'Observation sink size check failed.', {
      cause: error
    });
  }
  return currentBytes > 0 && currentBytes + additionalBytes > maxBytes;
}

function rotate(filePath: string, now: () => number, sequence: number): void {
  const timestamp = safeNow(now);
  const rotatedPath = `${filePath}.${formatRotationTimestamp(timestamp)}.${process.pid}.${sequence}.${randomUUID()}`;
  try {
    renameSync(filePath, rotatedPath);
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return;
    throw new ObservationSinkError('OBSERVATION_ROTATION_FAILED', 'Observation sink rotation failed.', {
      cause: error
    });
  }
}

function formatRotationTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? String(Math.trunc(timestamp)) : date.toISOString().replace(/[:.]/g, '-');
}

function normalizeSinkError(error: unknown): ObservationSinkError {
  if (error instanceof ObservationSinkError) return error;
  if (error instanceof ObservationSchemaError) {
    return new ObservationSinkError(
      'OBSERVATION_SCHEMA_INVALID',
      'Observation does not satisfy the persistence schema.',
      {
        cause: error
      }
    );
  }
  return new ObservationSinkError('OBSERVATION_WRITE_FAILED', 'Observation sink write failed.', { cause: error });
}

function readPositiveInteger(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`Observation sink ${field} must be a positive integer`);
  return value;
}

function readOwnerOnlyFileMode(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o777) {
    throw new Error('Observation sink fileMode must be a valid POSIX mode');
  }
  if ((value & OWNER_ONLY_MODE_MASK) !== 0 || (value & OWNER_WRITE_MODE) === 0) {
    throw new Error('Observation sink fileMode must be owner-only and writable');
  }
  return value;
}

function safeNow(now: () => number): number {
  try {
    const value = now();
    return Number.isFinite(value) ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function isNodeError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
