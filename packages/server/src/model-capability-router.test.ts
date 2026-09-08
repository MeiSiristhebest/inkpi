import { AssistantEventStream, type ModelConfig } from '@inkpi/ai';
import type { AiTask } from '@inkpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityMismatchError, CapabilityRouter, type ModelRoute } from './model-capability-router.js';
import { InkPiDaemon } from './daemon.js';

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
    const daemon = new InkPiDaemon({ defaultModel: baseModel });
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
