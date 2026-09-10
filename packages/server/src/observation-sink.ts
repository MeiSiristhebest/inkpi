import { appendFileSync } from 'node:fs';
import type { TaskRunObservation } from '@inkpi/agent-core';

/** A sink for observations that have already passed TaskObservability sanitization. */
export type TaskObservationSink = (observation: TaskRunObservation) => void;

/**
 * Create an append-only JSONL sink for production task observations.
 *
 * TaskObservability invokes this callback with a sanitized clone, so the sink
 * never receives raw private reasoning from the task runtime. The file is
 * opened per record to keep the sink stateless across daemon lifecycle events.
 */
export function createJsonlObservationSink(filePath: string): TaskObservationSink {
  const normalizedPath = filePath.trim();
  if (!normalizedPath) throw new Error('Observation sink file path must not be empty');

  return (observation) => {
    appendFileSync(normalizedPath, `${JSON.stringify(observation)}\n`, { encoding: 'utf8' });
  };
}
