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
