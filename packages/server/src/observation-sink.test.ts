import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { TaskObservability, isTaskObservationRecord } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { createJsonlObservationSink } from './observation-sink.js';

const task: AiTask = {
  id: 'observation-sink-task',
  kind: 'test.observation',
  input: { text: 'public input' }
};

describe('production JSONL observation sink', () => {
  it('writes one sanitized observation per line without private reasoning', () => {
    const filePath = join(tmpdir(), `inkpi-observation-${crypto.randomUUID()}.jsonl`);
    const observer = new TaskObservability({
      random: () => 0,
      onObservation: createJsonlObservationSink(filePath)
    });

    observer.started(task);
    observer.finished(task, {
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      provenance: {
        taskId: task.id,
        reasoning: 'private reasoning must not be persisted',
        decision: 'public result'
      },
      usage: { reasoning: 'private reasoning must not be persisted' }
    });

    const lines = readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      schema: 'inkpi.task-observation',
      schemaVersion: 1,
      eventType: 'task_observation',
      taskId: task.id,
      provenance: { decision: 'public result' }
    });
    expect(isTaskObservationRecord(record)).toBe(true);
    expect(lines[0]).not.toContain('private reasoning');
  });

  it('redacts raw reasoning when the sink is called directly', () => {
    const filePath = join(tmpdir(), `inkpi-observation-${crypto.randomUUID()}.jsonl`);
    const sink = createJsonlObservationSink(filePath);

    sink({
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      provenance: {
        analysis: 'private analysis',
        nested: { scratchpad: 'private scratchpad' },
        answer: 'safe <think>hidden chain</think> answer',
        prompt: 'full prompt must not be persisted',
        apiKey: 'secret-value'
      }
    });

    const line = readFileSync(filePath, 'utf8').trim();
    expect(JSON.parse(line)).toMatchObject({ provenance: { answer: 'safe  answer', nested: {} } });
    expect(line).not.toContain('private analysis');
    expect(line).not.toContain('private scratchpad');
    expect(line).not.toContain('hidden chain');
    expect(line).not.toContain('full prompt');
    expect(line).not.toContain('secret-value');
  });

  it('rejects an empty path before the daemon starts', () => {
    expect(() => createJsonlObservationSink('  ')).toThrow(/file path/i);
  });

  it('keeps every append as a complete JSONL record and reports sink health', () => {
    const filePath = join(tmpdir(), `inkpi-observation-${crypto.randomUUID()}.jsonl`);
    const sink = createJsonlObservationSink(filePath);

    for (let index = 0; index < 20; index += 1) {
      sink({
        taskId: `${task.id}-${index}`,
        kind: task.kind,
        status: 'completed',
        provenance: { index }
      });
    }

    const lines = readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
    expect(lines).toHaveLength(20);
    expect(lines.every((line) => isTaskObservationRecord(JSON.parse(line)))).toBe(true);
    expect(sink.getHealth()).toMatchObject({
      healthy: true,
      recordsWritten: 20,
      rotations: 0,
      writeErrors: 0,
      consecutiveErrors: 0
    });
  });

  it('rotates before crossing the configured file size without deleting the old segment', () => {
    const filePath = join(tmpdir(), `inkpi-observation-${crypto.randomUUID()}.jsonl`);
    const sink = createJsonlObservationSink(filePath, { maxBytes: 200, now: () => 123 });
    const observation = {
      taskId: task.id,
      kind: task.kind,
      status: 'completed' as const,
      provenance: { publicSummary: 'a record large enough to trigger rotation' }
    };

    sink(observation);
    sink({ ...observation, taskId: `${task.id}-second` });

    const rotatedFiles = readdirSync(dirname(filePath)).filter((name) => name.startsWith(`${basename(filePath)}.`));
    expect(rotatedFiles).toHaveLength(1);
    expect(readFileSync(join(dirname(filePath), rotatedFiles[0]), 'utf8')).toContain(task.id);
    expect(readFileSync(filePath, 'utf8')).toContain(`${task.id}-second`);
    expect(sink.getHealth()).toMatchObject({ healthy: true, recordsWritten: 2, rotations: 1 });
  });

  it('rejects malformed records and exposes the failure in health state', () => {
    const sink = createJsonlObservationSink(join(tmpdir(), `inkpi-observation-${crypto.randomUUID()}.jsonl`));

    expect(() =>
      sink({
        taskId: task.id,
        kind: task.kind,
        status: 'not-a-task-status' as never,
        provenance: {}
      })
    ).toThrow(/schema/i);
    expect(sink.getHealth()).toMatchObject({ healthy: false, recordsWritten: 0, writeErrors: 1 });
  });

  it('validates record and rotation limits at construction time', () => {
    const filePath = join(tmpdir(), `inkpi-observation-${crypto.randomUUID()}.jsonl`);
    expect(() => createJsonlObservationSink(filePath, { maxBytes: 0 })).toThrow(/maxBytes/);
    expect(() => createJsonlObservationSink(filePath, { maxRecordBytes: 0 })).toThrow(/maxRecordBytes/);
    expect(() => createJsonlObservationSink(filePath, { fileMode: 0o644 })).toThrow(/owner-only/);
  });
});
