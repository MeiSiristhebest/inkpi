import {
  ContextPipeline,
  DomainProposalLedger,
  RuntimeCacheCoordinator,
  type TaskHandlerContext,
  TaskRegistry,
  TaskRouter
} from '@inkpi/agent-core';
import { AssistantEventStream, type ModelConfig } from '@inkpi/ai';
import { type AiTask, type DomainChangeSet, calculateDomainChangeSetChecksum } from '@inkpi/protocol';
import { CapabilityMismatchError, CapabilityRouter, TaskModelHandler } from '@inkpi/server';
import { DomainProjectionStore, InkDb } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

const model = (id: string): ModelConfig => ({
  id,
  name: id,
  provider: 'faux'
});

function streamText(text: string): AssistantEventStream {
  const stream = new AssistantEventStream();
  queueMicrotask(() => {
    stream.push({ type: 'text_delta', textDelta: text });
    stream.end();
  });
  return stream;
}

function handlerContext(task: AiTask, context: TaskHandlerContext['context']): TaskHandlerContext {
  return {
    task,
    context,
    signal: new AbortController().signal,
    executionRunId: `run:${task.id}`,
    attempt: 1,
    consumeSteering: () => [],
    saveCheckpoint: async () => undefined,
    reportProgress: () => undefined
  };
}

function changeSet(revision: number, baseRevision: number): DomainChangeSet {
  const unsigned = {
    id: `phase22-change-${revision}`,
    workspaceId: 'phase22-workspace',
    sourceDeviceId: 'phase22-desktop',
    baseRevision,
    revision,
    changes: [],
    createdAt: revision
  } satisfies Omit<DomainChangeSet, 'checksum'>;
  return { ...unsigned, checksum: calculateDomainChangeSetChecksum(unsigned) };
}

describe('Phase 22 reliability matrix', () => {
  it('combines model unavailability with capability mismatch before provider or cache access', async () => {
    let providerCalls = 0;
    const capabilityRouter = new CapabilityRouter(
      [
        {
          id: 'structured-tools-unavailable',
          model: model('structured-tools-model'),
          capabilities: {
            outputFormats: ['structured'],
            structuredOutput: true,
            tools: true
          },
          stream: () => {
            providerCalls += 1;
            return streamText('{"unexpected":true}');
          }
        },
        {
          id: 'available-text-only',
          model: model('text-only-model'),
          capabilities: { outputFormats: ['text'] },
          stream: () => {
            providerCalls += 1;
            return streamText('unexpected');
          }
        }
      ],
      {
        routeStates: new Map([
          ['structured-tools-unavailable', { availability: 'unavailable' as const }],
          ['available-text-only', { availability: 'available' as const }]
        ])
      }
    );
    const handler = new TaskModelHandler({ capabilityRouter });
    const task: AiTask = {
      id: 'phase22-routing-gate',
      kind: 'phase22.routing',
      input: {},
      outputContract: { format: 'structured' },
      requirements: { needsStructuredOutput: true, needsTools: true }
    };

    await expect(
      handler.execute(
        handlerContext(task, {
          fragments: [],
          text: '',
          tokenEstimate: 0,
          fingerprint: 'phase22-routing-context',
          truncated: false
        })
      )
    ).rejects.toMatchObject({
      code: 'CAPABILITY_MISMATCH',
      details: {
        routes: [
          {
            routeId: 'structured-tools-unavailable',
            missing: ['availability:available']
          },
          {
            routeId: 'available-text-only',
            missing: expect.arrayContaining(['outputFormat:structured', 'tools'])
          }
        ]
      }
    });
    expect(() => capabilityRouter.resolve(task)).toThrow(CapabilityMismatchError);
    expect(providerCalls).toBe(0);
    expect(handler.getProviderResponseCache().stats()).toEqual({
      hits: 0,
      misses: 0,
      evictions: 0,
      invalidations: 0
    });
  });

  it('does not let invalid structured output poison truncated context or survive revision invalidation', async () => {
    const coordinator = new RuntimeCacheCoordinator();
    const pipeline = new ContextPipeline({ maxTokens: 1, cacheCoordinator: coordinator });
    let contextCalls = 0;
    pipeline.register({
      id: 'phase22-context',
      provide: () => {
        contextCalls += 1;
        return [
          { id: 'required', source: 'fixture', text: 'keep', tokenEstimate: 1, priority: 10 },
          { id: 'overflow', source: 'fixture', text: 'drop me', tokenEstimate: 2, priority: 1 }
        ];
      }
    });

    const responses = ['not-json', '{"answer":"fresh"}', '{"answer":"after-invalidation"}'];
    let providerCalls = 0;
    let unavailableCalls = 0;
    const handler = new TaskModelHandler({
      cacheCoordinator: coordinator,
      capabilityRouter: new CapabilityRouter(
        [
          {
            id: 'unavailable-primary',
            model: model('unavailable-primary-model'),
            capabilities: { outputFormats: ['structured'], structuredOutput: true },
            stream: () => {
              unavailableCalls += 1;
              return streamText('{"unexpected":true}');
            }
          },
          {
            id: 'available-fallback',
            model: model('available-fallback-model'),
            fallback: true,
            capabilities: { outputFormats: ['structured'], structuredOutput: true },
            stream: () => {
              const response = responses[providerCalls];
              providerCalls += 1;
              if (response === undefined) throw new Error('unexpected provider call');
              return streamText(response);
            }
          }
        ],
        {
          routeStates: new Map([
            ['unavailable-primary', { availability: 'unavailable' as const }],
            ['available-fallback', { availability: 'available' as const }]
          ])
        }
      )
    });
    const task: AiTask = {
      id: 'phase22-cache-matrix',
      kind: 'phase22.cache-matrix',
      input: {
        selection: { documentId: 'document-1', from: 0, to: 4, revision: 1 }
      },
      contextPolicy: { maxTokens: 1 },
      outputContract: { format: 'structured' }
    };

    const firstPacket = await pipeline.build(task);
    expect(firstPacket).toMatchObject({ truncated: true, tokenEstimate: 1, projectRevision: 1 });
    await expect(handler.execute(handlerContext(task, firstPacket))).rejects.toMatchObject({
      message: 'Model output is not valid JSON',
      retryable: false
    });

    const cachedPacket = await pipeline.build(task);
    const fresh = await handler.execute(handlerContext(task, cachedPacket));
    const cached = await handler.execute(handlerContext(task, cachedPacket));
    expect(fresh.output).toEqual({ format: 'structured', data: { answer: 'fresh' } });
    expect(cached.output).toEqual(fresh.output);
    expect(cached.provenance).toMatchObject({ cacheHit: true, routeId: 'available-fallback' });

    coordinator.invalidate({ reason: 'revision', projectRevision: 2 });
    const rebuiltPacket = await pipeline.build(task);
    const rebuilt = await handler.execute(handlerContext(task, rebuiltPacket));

    expect(rebuilt.output).toEqual({
      format: 'structured',
      data: { answer: 'after-invalidation' }
    });
    expect(rebuilt.provenance).toMatchObject({ cacheHit: false, routeId: 'available-fallback' });
    expect(unavailableCalls).toBe(0);
    expect(providerCalls).toBe(3);
    expect(contextCalls).toBe(2);
    expect(pipeline.cacheStats()).toMatchObject({ hits: 1, misses: 2, invalidations: 1 });
    expect(handler.getProviderResponseCache().stats()).toMatchObject({
      hits: 1,
      misses: 3,
      invalidations: 1
    });
    expect(coordinator.stats()).toMatchObject({
      context: { hits: 1, misses: 2, invalidations: 1 },
      provider: { hits: 1, misses: 3, invalidations: 1 }
    });
  });

  it('rejects a duplicate task while the original is fenced as a stale proposal', async () => {
    const ledger = new DomainProposalLedger(() => 10);
    const registry = new TaskRegistry();
    let executions = 0;
    let applyCalls = 0;
    registry.register({
      id: 'phase22-stale-proposal-handler',
      kinds: ['phase22.stale-proposal'],
      async execute({ task }) {
        executions += 1;
        const proposal = ledger.create({
          id: 'phase22-stale-proposal',
          taskId: task.id,
          baseRevision: 4,
          sourceHash: 'document-revision-4',
          target: { type: 'document', id: 'document-1' },
          operation: 'update',
          patch: { text: 'candidate' }
        });
        ledger.accept(proposal.id);
        await ledger.commit(proposal.id, 5, () => {
          applyCalls += 1;
          return { inversePatch: { text: 'original' } };
        });
        return { output: { format: 'text', text: 'unexpected' } };
      }
    });
    const router = new TaskRouter({ registry, now: () => 10 });
    const task: AiTask = {
      id: 'phase22-duplicate-task',
      kind: 'phase22.stale-proposal',
      input: {},
      outputContract: { format: 'text' }
    };

    expect(router.submit(task)).toMatchObject({ status: 'queued' });
    expect(() => router.submit(task)).toThrow(`Task already exists: ${task.id}`);
    await expect(router.wait(task.id)).resolves.toMatchObject({
      status: 'failed',
      error: {
        code: 'TASK_FAILED',
        message: 'Proposal phase22-stale-proposal is stale: expected revision 4, received 5'
      }
    });

    expect(executions).toBe(1);
    expect(applyCalls).toBe(0);
    expect(ledger.get('phase22-stale-proposal')).toMatchObject({ status: 'stale' });
    await expect(ledger.commit('phase22-stale-proposal', 5, () => ({ inversePatch: {} }))).rejects.toThrow(
      'must be accepted before commit'
    );
  });

  it('keeps the projection unchanged across checksum corruption and out-of-order delivery', () => {
    const db = new InkDb();
    try {
      const projection = new DomainProjectionStore(db, () => 10);
      const corrupted = { ...changeSet(1, 0), checksum: '00000000' };

      expect(() => projection.apply(corrupted)).toThrow('checksum mismatch');
      expect(projection.apply(changeSet(2, 1))).toMatchObject({
        accepted: false,
        duplicate: false,
        revision: 0,
        reason: 'revision-conflict'
      });
      expect(projection.getCursor('phase22-workspace').revision).toBe(0);
      expect(projection.list('phase22-workspace')).toEqual([]);

      expect(projection.apply(changeSet(1, 0))).toMatchObject({ accepted: true, revision: 1 });
      expect(projection.apply(changeSet(2, 1))).toMatchObject({ accepted: true, revision: 2 });
      expect(projection.list('phase22-workspace').map(({ id }) => id)).toEqual([
        'phase22-change-1',
        'phase22-change-2'
      ]);
    } finally {
      db.close();
    }
  });
});
