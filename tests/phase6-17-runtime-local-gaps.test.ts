import {
  ArtifactRuntime,
  ContextPipeline,
  TaskRegistry,
  TaskRouter,
  TaskScheduler,
  type ScheduledTaskState
} from '@inkpi/agent-core';
import type { AiTask, Artifact, ArtifactStore, ModelConfig } from '@inkpi/protocol';
import { CapabilityRouter, InkPiDaemon } from '@inkpi/server';
import { describe, expect, it, vi } from 'vitest';

function textTask(id: string, overrides: Partial<AiTask> = {}): AiTask {
  return {
    id,
    kind: 'test.phase6-17',
    input: {},
    outputContract: { format: 'text' },
    ...overrides
  };
}

class MemoryArtifactStore implements ArtifactStore {
  readonly values = new Map<string, Artifact>();
  saves = 0;

  save(artifact: Artifact): void {
    this.saves += 1;
    this.values.set(artifact.id, structuredClone(artifact));
  }

  get(id: string): Artifact | undefined {
    const artifact = this.values.get(id);
    return artifact ? structuredClone(artifact) : undefined;
  }

  list(taskId?: string): Artifact[] {
    return [...this.values.values()]
      .filter((artifact) => !taskId || artifact.provenance.taskId === taskId)
      .map((artifact) => structuredClone(artifact));
  }
}

class MemorySchedulerPersistence {
  private readonly values = new Map<string, ScheduledTaskState>();

  save(state: ScheduledTaskState): void {
    this.values.set(state.id, structuredClone(state));
  }

  load(id: string): ScheduledTaskState | undefined {
    const state = this.values.get(id);
    return state ? structuredClone(state) : undefined;
  }
}

describe('Plan Phase 6-17 Runtime local gaps', () => {
  it('passes project revision into providers and preserves max-fragment truncation', async () => {
    const pipeline = new ContextPipeline();
    let seenRevision: number | undefined;
    pipeline.register({
      id: 'revision-provider',
      provide: (request) => {
        seenRevision = request.projectRevision;
        return [
          { id: 'first', source: 'fixture', text: 'first', priority: 2 },
          { id: 'second', source: 'fixture', text: 'second', priority: 1 }
        ];
      }
    });

    const packet = await pipeline.build(
      textTask('context-contract', {
        metadata: { projectRevision: 8 },
        contextPolicy: { maxFragments: 1, maxTokens: 100 }
      })
    );

    expect(seenRevision).toBe(8);
    expect(packet.projectRevision).toBe(8);
    expect(packet.fragments).toHaveLength(1);
    expect(packet.truncated).toBe(true);
  });

  it('persists a real retry deadline so a rebuilt scheduler can continue it', async () => {
    vi.useFakeTimers();
    try {
      const persistence = new MemorySchedulerPersistence();
      let currentTime = 1_000;
      const now = () => currentTime;
      let calls = 0;
      const work = {
        id: 'retry-restart',
        mode: 'background' as const,
        maxAttempts: 2,
        retryDelayMs: 100,
        run: async () => {
          calls += 1;
          if (calls === 1) {
            const error = new Error('temporary') as Error & { retryable?: boolean };
            error.retryable = true;
            throw error;
          }
          return 'recovered';
        }
      };
      const first = new TaskScheduler({ now, persistence });
      const initial = first.schedule(work);
      await vi.advanceTimersByTimeAsync(0);
      await first.flush();

      expect(persistence.load(work.id)).toMatchObject({
        status: 'queued',
        readyAt: 1_100
      });

      const second = new TaskScheduler({ now, persistence });
      const restored = await second.rehydrate(work);
      expect(restored).toBeDefined();
      currentTime = 1_099;
      await vi.advanceTimersByTimeAsync(99);
      expect(second.status(work.id).status).toBe('queued');
      currentTime = 1_100;
      await vi.advanceTimersByTimeAsync(1);
      await expect(restored?.promise).resolves.toBe('recovered');
      expect(second.status(work.id)).toMatchObject({ status: 'completed', attempts: 2 });
      expect(second.status(work.id).error).toBeUndefined();

      await first.stop();
      await initial.promise;
      await second.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create a second artifact when the same task result is persisted again', async () => {
    const store = new MemoryArtifactStore();
    let now = 10;
    const runtime = new ArtifactRuntime(store, () => now++);
    const task = textTask('artifact-idempotency', {
      outputContract: { format: 'structured', persistence: 'artifact', schemaId: 'runtime.summary' }
    });
    const result = {
      taskId: task.id,
      kind: task.kind,
      status: 'completed' as const,
      output: { format: 'structured' as const, data: { value: 1 } }
    };

    const first = await runtime.persistTaskResult(task, result);
    const second = await runtime.persistTaskResult(task, result);

    expect(second).toEqual(first);
    expect(store.saves).toBe(1);
  });

  it('maps named output capabilities and does not treat an empty schema list as support', () => {
    const model: ModelConfig = { id: 'capability-model', name: 'Capability model', provider: 'faux' };
    const named = new CapabilityRouter([
      {
        id: 'named-capabilities',
        model,
        capabilities: { outputFormats: ['text'], structuredOutput: true, patchOutput: true }
      }
    ]);
    expect(
      named.resolve({
        id: 'named-capability-task',
        kind: 'test.capability',
        input: {},
        outputContract: { format: 'text' },
        requirements: { capabilities: ['structuredOutput', 'patchOutput'] }
      }).id
    ).toBe('named-capabilities');

    const emptySchema = new CapabilityRouter([
      { id: 'empty-schema', model, capabilities: { jsonSchema: [], outputFormats: ['text'] } }
    ]);
    expect(() =>
      emptySchema.resolve({
        id: 'empty-schema-task',
        kind: 'test.capability',
        input: {},
        outputContract: { format: 'structured' }
      })
    ).toThrow(/Capability mismatch/);
  });

  it('keeps instruction provenance across the Runtime RPC registration boundary', async () => {
    const daemon = new InkPiDaemon();
    try {
      const provenance = { source: 'skill', skillId: 'skill-a', skillVersion: '2.0.0' };
      const response = await daemon.getRpcServer().handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'instruction.register',
        params: {
          instruction: {
            id: 'skill-a.instruction',
            version: '2.0.0',
            taskKind: 'test.provenance',
            systemInstruction: 'Use the registered instruction.',
            provenance
          }
        }
      });

      expect(response.error).toBeUndefined();
      expect(response.result).toMatchObject({ results: [{ provenance }] });
      expect(daemon.getInstructionRegistry().list()[0]?.provenance).toEqual(provenance);
    } finally {
      await daemon.stop();
    }
  });

  it('freezes a submitted task before asynchronous execution starts', async () => {
    const registry = new TaskRegistry();
    registry.register({
      id: 'snapshot-task-handler',
      kinds: ['test.task-snapshot'],
      async execute({ task }) {
        return { output: { format: 'text', text: String((task.input.payload as { value: string }).value) } };
      }
    });
    const router = new TaskRouter({ registry });
    const task = textTask('task-snapshot', {
      kind: 'test.task-snapshot',
      input: { payload: { value: 'original' } }
    });

    router.submit(task);
    (task.input.payload as { value: string }).value = 'mutated';

    await expect(router.wait(task.id)).resolves.toMatchObject({ output: { text: 'original' } });
    await router.stop();
  });
});
