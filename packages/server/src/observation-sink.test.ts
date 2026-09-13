import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskObservability } from '@inkpi/agent-core';
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
    expect(JSON.parse(lines[0])).toMatchObject({
      taskId: task.id,
      provenance: { decision: 'public result' }
    });
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
        answer: 'safe <think>hidden chain</think> answer'
      }
    });

    const line = readFileSync(filePath, 'utf8').trim();
    expect(JSON.parse(line)).toMatchObject({ provenance: { answer: 'safe  answer', nested: {} } });
    expect(line).not.toContain('private analysis');
    expect(line).not.toContain('private scratchpad');
    expect(line).not.toContain('hidden chain');
  });

  it('rejects an empty path before the daemon starts', () => {
    expect(() => createJsonlObservationSink('  ')).toThrow(/file path/i);
  });
});
