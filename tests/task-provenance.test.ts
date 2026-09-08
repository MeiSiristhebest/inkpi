import { TaskObservability, TaskRegistry, TaskRouter } from '@inkpi/agent-core';
import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

const rawCotKeys = ['thinking', 'reasoning', 'chainOfThought', 'cot', 'rawThinking'] as const;

describe('observability provenance contract', () => {
  it('covers the public observation fields with deterministic values', () => {
    let now = 100;
    const observer = new TaskObservability(() => now);
    const task: AiTask = {
      id: 'field-covered-task',
      kind: 'test.provenance',
      input: {
        selection: { documentId: 'doc-1', from: 0, to: 4, revision: 7 }
      },
      metadata: {
        executionRunId: 'run-from-metadata',
        instructionId: 'instruction-1',
        instructionVersion: 'instruction-v1',
        routeId: 'route-1',
        skillIds: ['skill-a', 'skill-b'],
        skillVersions: { 'skill-a': '1.0.0', 'skill-b': '2.0.0' },
        provider: 'fixture-provider',
        model: 'fixture-model'
      }
    };

    observer.started(task);
    now = 125;
    observer.contextBuilt(task, {
      fragments: [{ id: 'fragment-1', source: 'selection' }],
      text: 'fixture context',
      tokenEstimate: 3,
      fingerprint: 'context-fingerprint',
      truncated: false,
      projectRevision: 7
    });
    observer.progress(task, 0.75);
    now = 140;
    observer.finished(task, {
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      startedAt: 100,
      finishedAt: now,
      progress: 0.75,
      contextFingerprint: 'context-fingerprint',
      contextSources: ['selection'],
      contextTokenCount: 3,
      projectRevision: 7,
      instructionId: 'instruction-1',
      routeId: 'route-1',
      instructionVersion: 'instruction-v1',
      skillIds: ['skill-a', 'skill-b'],
      skillVersions: { 'skill-a': '1.0.0', 'skill-b': '2.0.0' },
      provider: 'fixture-provider',
      model: 'fixture-model',
      latencyMs: 12,
      usage: { inputTokens: 10, outputTokens: 4 },
      cache: { hit: false },
      tools: ['fixture-tool'],
      resultType: 'structured',
      artifactIds: ['artifact-1'],
      proposalIds: ['proposal-1'],
      checkpointIds: ['checkpoint-1'],
      checkpoint: { step: 'draft', updatedAt: 130 },
      error: undefined,
      provenance: {
        taskId: task.id,
        taskKind: task.kind,
        createdAt: 100,
        contextFingerprint: 'context-fingerprint',
        contextFragmentIds: ['fragment-1'],
        executionRunId: 'run:field-covered-task',
        executionAttempt: 1
      }
    });

    expect(observer.get(task.id)).toEqual({
      taskId: task.id,
      kind: task.kind,
      executionRunId: 'run-from-metadata',
      status: 'completed',
      startedAt: 100,
      finishedAt: 140,
      durationMs: 40,
      progress: 0.75,
      contextFingerprint: 'context-fingerprint',
      contextSources: ['selection'],
      contextTokenCount: 3,
      projectRevision: 7,
      instructionId: 'instruction-1',
      routeId: 'route-1',
      instructionVersion: 'instruction-v1',
      skillIds: ['skill-a', 'skill-b'],
      skillVersions: { 'skill-a': '1.0.0', 'skill-b': '2.0.0' },
      provider: 'fixture-provider',
      model: 'fixture-model',
      latencyMs: 12,
      usage: { inputTokens: 10, outputTokens: 4 },
      cache: { hit: false },
      tools: ['fixture-tool'],
      resultType: 'structured',
      artifactIds: ['artifact-1'],
      proposalIds: ['proposal-1'],
      checkpointIds: ['checkpoint-1'],
      checkpoint: { step: 'draft', updatedAt: 130 },
      error: undefined,
      provenance: {
        taskId: task.id,
        taskKind: task.kind,
        createdAt: 100,
        contextFingerprint: 'context-fingerprint',
        contextFragmentIds: ['fragment-1'],
        executionRunId: 'run:field-covered-task',
        executionAttempt: 1
      }
    });
  });

  it('keeps raw chain-of-thought out of router observations', async () => {
    const task: AiTask = {
      id: 'raw-cot-task',
      kind: 'test.raw-cot',
      input: { text: 'deterministic context' },
      outputContract: { format: 'text' }
    };
    const registry = new TaskRegistry();
    registry.register({
      id: 'raw-cot-fixture-handler',
      kinds: [task.kind],
      async execute() {
        return {
          output: { format: 'text', text: 'safe result' },
          provenance: {
            provider: 'fixture-provider',
            model: 'fixture-model',
            instructionId: 'instruction-1',
            routeId: 'route-1',
            skillIds: ['skill-a'],
            usage: { outputTokens: 2 },
            thinking: 'raw thinking must not be observed',
            reasoning: 'raw reasoning must not be observed',
            chainOfThought: 'raw chain of thought must not be observed',
            cot: 'raw cot must not be observed',
            rawThinking: 'raw thinking alias must not be observed'
          }
        };
      }
    });

    const observer = new TaskObservability(() => 10);
    const router = new TaskRouter({ registry, observer, now: () => 10 });
    router.submit(task);
    await router.wait(task.id);

    const observation = observer.get(task.id);
    expect(observation).toMatchObject({
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      provider: 'fixture-provider',
      model: 'fixture-model',
      instructionId: 'instruction-1',
      routeId: 'route-1',
      skillIds: ['skill-a'],
      usage: { outputTokens: 2 },
      resultType: 'text',
      provenance: {
        taskId: task.id,
        taskKind: task.kind,
        provider: 'fixture-provider',
        model: 'fixture-model',
        instructionId: 'instruction-1',
        routeId: 'route-1',
        skillIds: ['skill-a'],
        usage: { outputTokens: 2 }
      }
    });
    expect(observation).toBeDefined();
    for (const key of rawCotKeys) {
      expect(observation).not.toHaveProperty(key);
      expect(observation?.provenance).not.toHaveProperty(key);
    }
    expect(JSON.stringify(observation)).not.toContain('must not be observed');
  });
});
