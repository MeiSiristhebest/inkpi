import { appendFileSync } from 'node:fs';
import { type TaskRunObservation, sanitizePrivateData } from '@inkpi/agent-core';

/** A sink that enforces the observation privacy boundary before persistence. */
export type TaskObservationSink = (observation: TaskRunObservation) => void;

/**
 * Create an append-only JSONL sink for production task observations.
 *
 * TaskObservability invokes this callback with a sanitized clone. Re-sanitize at
 * the durable boundary as well so direct callers cannot bypass that contract.
 * The file is opened per record to keep the sink stateless across daemon
 * lifecycle events.
 */
export function createJsonlObservationSink(filePath: string): TaskObservationSink {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) throw new Error('Observation sink file path must not be empty');

  return (observation) => {
    const safeObservation = sanitizePrivateData(observation);
    appendFileSync(normalizedPath, `${JSON.stringify(safeObservation)}\n`, { encoding: 'utf8' });
  };
}
