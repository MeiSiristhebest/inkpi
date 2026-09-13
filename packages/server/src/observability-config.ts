/**
 * Read the daemon's production observation sampling policy.
 *
 * Sampling is opt-in through an environment variable so local runs retain
 * their existing behavior while deployed daemons can bound telemetry volume.
 * Invalid values fail startup instead of silently changing the sampling rate.
 */
export function readObservabilitySampleRate(env: Record<string, string | undefined> = process.env): number | undefined {
  const raw = env.INKPI_OBSERVABILITY_SAMPLE_RATE?.trim();
  if (!raw) return undefined;

  const sampleRate = Number(raw);
  if (!Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1) {
    throw new Error('INKPI_OBSERVABILITY_SAMPLE_RATE must be a number between 0 and 1');
  }
  return sampleRate;
}

export interface ObservationSinkConfig {
  /** Rotate the active JSONL segment before it exceeds this byte size. */
  maxBytes?: number;
  /** Reject a single JSONL record larger than this byte size. */
  maxRecordBytes?: number;
}

/** Read optional JSONL sink size bounds used by the standalone daemon entrypoint. */
export function readObservationSinkConfig(
  env: Record<string, string | undefined> = process.env
): ObservationSinkConfig {
  const maxBytes = readPositiveInteger(env.INKPI_OBSERVABILITY_MAX_BYTES, 'INKPI_OBSERVABILITY_MAX_BYTES');
  const maxRecordBytes = readPositiveInteger(
    env.INKPI_OBSERVABILITY_MAX_RECORD_BYTES,
    'INKPI_OBSERVABILITY_MAX_RECORD_BYTES'
  );
  return {
    ...(maxBytes === undefined ? {} : { maxBytes }),
    ...(maxRecordBytes === undefined ? {} : { maxRecordBytes })
  };
}

function readPositiveInteger(raw: string | undefined, name: string): number | undefined {
  if (!raw?.trim()) return undefined;
  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}
