import { AssistantEventStream, type ModelConfig } from '@inkpi/ai';
import type { AiTask } from '@inkpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InkPiDaemon } from './daemon.js';
import {
  CapabilityMismatchError,
  CapabilityRouter,
  type ModelRoute,
  type ModelRouteRuntimeState
} from './model-capability-router.js';
import { TaskModelHandler } from './task-model-handler.js';

const baseModel: ModelConfig = {
  id: 'base-model',
  name: 'Base model',
  provider: 'faux'
};

function task(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'capability-task',
    kind: 'test.capability',
    input: { text: 'context' },
    outputContract: { format: 'structured' },
    ...overrides
  };
}

function streamThatReturns(text: string) {
  return () => {
    const stream = new AssistantEventStream();
    queueMicrotask(() => {
      stream.push({ type: 'text_delta', textDelta: text });
      stream.end();
    });
    return stream;
  };
}

describe('capability-aware model routing', () => {
  const daemons: InkPiDaemon[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  });

  it('filters requirements and deterministically sorts matching routes', () => {
    const routes: ModelRoute[] = [
      {
        id: 'z-full',
        model: { ...baseModel, id: 'z-model' },
        priority: 10,
        capabilities: {
          capabilities: ['analysis'],
          tools: ['lookup'],
          modalities: ['text'],
          network: 'required',
          outputFormats: ['structured', 'patch'],
          streaming: true,
          contextTokens: 8_000,
          maxLatencyMs: 500,
          maxCostUsd: 0.2,
          reasoning: true,
          structuredOutput: true,
          patchOutput: true
        }
      },
      {
        id: 'a-full',
        model: { ...baseModel, id: 'a-model' },
        priority: 10,
        capabilities: {
          capabilities: ['analysis'],
          tools: ['lookup'],
          modalities: ['text'],
          network: 'required',
          outputFormats: ['structured', 'patch'],
          streaming: true,
          contextTokens: 8_000,
          maxLatencyMs: 500,
          maxCostUsd: 0.2,
          reasoning: true,
          structuredOutput: true,
          patchOutput: true
        }
      },
      {
        id: 'a-no-reasoning',
        model: { ...baseModel, id: 'a-plain' },
        capabilities: { outputFormats: ['structured'], structuredOutput: true }
      }
    ];

    const selected = new CapabilityRouter(routes).resolve(
      task({
        requirements: {
          capabilities: ['analysis'],
          tools: ['lookup'],
          modalities: ['text'],
          network: 'required',
          outputFormats: ['structured', 'patch'],
          streaming: true,
          minContextTokens: 4_000,
          maxLatencyMs: 1_000,
          maxCostUsd: 0.5,
          needsTools: true,
          needsStructuredOutput: true,
          needsReasoning: true,
          needsStreaming: true,
          minimumContext: 2_000
        }
      })
    );

    expect(selected.id).toBe('a-full');
  });

  it('filters injected availability, health, and quota state and refreshes it per resolve', () => {
    const routes: ModelRoute[] = ['ready', 'degraded', 'unhealthy', 'unavailable', 'exhausted'].map((id) => ({
      id,
      model: { ...baseModel, id },
      capabilities: { outputFormats: ['text'] }
    }));
    const states = new Map<string, ModelRouteRuntimeState>([
      ['ready', { availability: 'available', health: 'healthy', quota: { remaining: 10 } }],
      ['degraded', { availability: 'degraded', health: 'degraded', quota: { remaining: 5 } }],
      ['unhealthy', { availability: 'available', health: 'unhealthy', quota: { remaining: 10 } }],
      ['unavailable', { availability: 'unavailable', health: 'healthy', quota: { remaining: 10 } }],
      ['exhausted', { availability: 'available', health: 'healthy', quota: { remaining: 0 } }]
    ]);
    const router = new CapabilityRouter(routes, { routeStates: states });
    const textTask = task({ outputContract: { format: 'text' } });

    expect(router.resolveCandidates(textTask).map((route) => route.id)).toEqual(['ready', 'degraded']);

    states.set('ready', { availability: 'unavailable', health: 'healthy', quota: { remaining: 10 } });
    expect(router.resolve(textTask).id).toBe('degraded');

    states.set('degraded', { availability: 'unavailable', health: 'degraded', quota: { remaining: 5 } });
    expect(() => router.resolve(textTask)).toThrow(CapabilityMismatchError);
  });

  it('deterministically ranks preference, quality, latency, and cost after capability filtering', () => {
    const route = (id: string, ranking: ModelRoute['ranking']): ModelRoute => ({
      id,
      model: { ...baseModel, id },
      capabilities: { outputFormats: ['text'] },
      ranking
    });
    const routes = [
      route('slow', { userPreference: 1, quality: 0.8, latencyMs: 100, costUsd: 0.01 }),
      route('fast', { userPreference: 1, quality: 0.8, latencyMs: 10, costUsd: 0.8 }),
      route('cheap', { userPreference: 1, quality: 0.8, latencyMs: 10, costUsd: 0.1 }),
      route('quality', { userPreference: 1, quality: 0.9, latencyMs: 1_000, costUsd: 2 }),
      route('preferred', { userPreference: 2, quality: 0.1, latencyMs: 1_000, costUsd: 2 }),
      route('tie-b', { userPreference: 0, quality: 0.7, latencyMs: 20, costUsd: 0.2 }),
      route('tie-a', { userPreference: 0, quality: 0.7, latencyMs: 20, costUsd: 0.2 })
    ];
    const router = new CapabilityRouter(routes);
    const textTask = task({ outputContract: { format: 'text' } });

    expect(router.resolveCandidates(textTask).map((candidate) => candidate.id)).toEqual([
      'preferred',
      'quality',
      'cheap',
      'fast',
      'slow',
      'tie-a',
      'tie-b'
    ]);
  });

  it('keeps the default model as an explicit fallback and rejects mismatches', () => {
    const fallback = new CapabilityRouter([
      {
        id: 'default-model',
        model: baseModel,
        fallback: true,
        capabilities: { outputFormats: ['text'] }
      },
      {
        id: 'structured-model',
        model: { ...baseModel, id: 'structured' },
        capabilities: { outputFormats: ['structured'], structuredOutput: true }
      }
    ]);
    expect(fallback.resolve(task({ outputContract: { format: 'text' } })).id).toBe('default-model');
    expect(fallback.resolve(task()).id).toBe('structured-model');

    try {
      fallback.resolve(
        task({
          outputContract: { format: 'structured', schemaId: 'missing-schema' },
          requirements: { needsReasoning: true, network: 'offline' }
        })
      );
      throw new Error('expected capability mismatch');
    } catch (error) {
      expect(error).toBeInstanceOf(CapabilityMismatchError);
      expect(error).toMatchObject({
        code: 'CAPABILITY_MISMATCH',
        details: {
          taskId: 'capability-task',
          routes: expect.arrayContaining([
            expect.objectContaining({
              routeId: 'default-model',
              missing: expect.arrayContaining([
                'network:offline',
                'outputFormat:structured',
                'reasoning',
                'schema:missing-schema'
              ])
            })
          ])
        }
      });
      expect((error as Error).message).toContain('Capability mismatch');
    }
  });

  it('accepts the Phase 15 capability aliases and validates a contract schema', () => {
    const selected = new CapabilityRouter([
      {
        id: 'schema-tools',
        model: baseModel,
        capabilities: {
          toolCalling: true,
          jsonSchema: ['analysis.schema'],
          parallelToolCalling: true,
          maxContextTokens: 16_000,
          maxOutputTokens: 2_000,
          promptCaching: true,
          outputFormats: ['structured']
        }
      }
    ]).resolve(
      task({
        outputContract: { format: 'structured', schemaId: 'analysis.schema' },
        requirements: {
          capabilities: ['parallelToolCalling', 'promptCaching'],
          tools: ['lookup'],
          needsTools: true,
          minimumContext: 8_000
        }
      })
    );

    expect(selected.id).toBe('schema-tools');
  });

  it('treats optional network requirements as compatible with offline routes', () => {
    const selected = new CapabilityRouter([
      {
        id: 'offline',
        model: baseModel,
        capabilities: { network: 'offline', outputFormats: ['text'] }
      }
    ]).resolve({
      id: 'optional-network',
      kind: 'test.capability',
      input: {},
      outputContract: { format: 'text' },
      requirements: { network: 'optional' }
    });

    expect(selected.id).toBe('offline');
  });

  it('keeps omitted default capabilities compatible while explicit declarations stay strict', () => {
    const compatible = new TaskModelHandler({ model: baseModel });
    expect(
      compatible.getCapabilityRouter().resolve(
        task({
          outputContract: { format: 'text' },
          requirements: {
            capabilities: ['creative-writing'],
            modalities: ['text'],
            outputFormats: ['text'],
            streaming: true
          }
        })
      ).id
    ).toBe('default-model');

    const strict = new TaskModelHandler({ model: baseModel, defaultModelCapabilities: {} });
    expect(() => strict.getCapabilityRouter().resolve(task({ outputContract: { format: 'text' } }))).toThrow(
      CapabilityMismatchError
    );
  });

  it('selects the route before task.submit and records route provenance', async () => {
    const daemon = new InkPiDaemon({
      defaultModel: baseModel,
      modelRoutes: [
        {
          id: 'structured-offline',
          model: { ...baseModel, id: 'structured-model' },
          stream: streamThatReturns('{"answer":"ok"}'),
          capabilities: {
            network: 'offline',
            outputFormats: ['structured'],
            structuredOutput: true,
            reasoning: true,
            streaming: true,
            contextTokens: 4_000
          }
        }
      ]
    });
    daemons.push(daemon);

    const submitted = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'task.submit',
      params: {
        task: task({
          requirements: {
            network: 'offline',
            outputFormats: ['structured'],
            needsStructuredOutput: true,
            needsReasoning: true,
            needsStreaming: true,
            minimumContext: 2_000
          }
        })
      }
    });
    expect(submitted.error).toBeUndefined();

    const result = await daemon.getTaskRouter().wait('capability-task');
    expect(result.provenance).toMatchObject({
      selectedRoute: 'structured-offline',
      routeId: 'structured-offline',
      selectedProvider: 'faux',
      selectedModel: 'structured-model',
      provider: 'faux',
      model: 'structured-model'
    });
  });

  it('returns capability mismatch from task.submit before queueing the task', async () => {
    const daemon = new InkPiDaemon({ defaultModel: baseModel, defaultModelCapabilities: {} });
    daemons.push(daemon);

    const response = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'task.submit',
      params: { task: task({ id: 'mismatch-task', requirements: { needsTools: true } }) }
    });

    expect(response).toMatchObject({
      error: {
        code: 'CAPABILITY_MISMATCH',
        message: expect.stringContaining('Capability mismatch')
      }
    });
    expect(() => daemon.getTaskRouter().status('mismatch-task')).toThrow('Unknown task');
  });
});
