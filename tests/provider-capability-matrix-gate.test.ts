import {
  KNOWN_MODELS,
  type ModelCatalogEntry,
  findModelInCatalog,
  modelCatalogEntryToCapabilityDeclaration
} from '@inkpi/ai';
import type { AiTask, TaskRequirements } from '@inkpi/protocol';
import { CapabilityMismatchError, CapabilityRouter, type ModelRoute, createModelRouteFromCatalog } from '@inkpi/server';
import { describe, expect, it } from 'vitest';

const REPRESENTATIVE_MODELS = [
  { id: 'deepseek/deepseek-chat', provider: 'deepseek', reasoning: false, vision: false, network: 'required' },
  { id: 'deepseek/deepseek-r1', provider: 'deepseek', reasoning: true, vision: false, network: 'required' },
  { id: 'anthropic/claude-3.7-sonnet', provider: 'claude', reasoning: true, vision: true, network: 'required' },
  { id: 'openai/gpt-4o', provider: 'openai', reasoning: false, vision: true, network: 'required' },
  { id: 'openai/o3-mini', provider: 'openai', reasoning: true, vision: false, network: 'required' },
  { id: 'google/gemini-2.5-pro', provider: 'gemini', reasoning: true, vision: true, network: 'required' },
  { id: 'ollama/qwen2.5:14b', provider: 'ollama', reasoning: false, vision: false, network: 'offline' }
] as const;

function makeTask(overrides: Partial<AiTask> = {}): AiTask {
  return {
    id: 'provider-capability-task',
    kind: 'test.provider-capability',
    input: { text: 'provider capability fixture' },
    outputContract: { format: 'text' },
    ...overrides
  };
}

function routeFromCatalog(entry: ModelCatalogEntry): ModelRoute {
  return createModelRouteFromCatalog(entry);
}

describe('declared provider capability matrix', () => {
  it('keeps representative provider/model declarations routable by their advertised capabilities', () => {
    for (const expected of REPRESENTATIVE_MODELS) {
      const entry = findModelInCatalog(expected.id);
      expect(entry, `missing catalog entry: ${expected.id}`).toBeDefined();
      expect(entry).toMatchObject({
        provider: expected.provider,
        supportsThinking: expected.reasoning,
        supportsVision: expected.vision
      });

      const route = routeFromCatalog(entry!);
      const requirements: TaskRequirements = {
        network: expected.network,
        modalities: expected.vision ? ['text', 'image'] : ['text'],
        outputFormats: ['text'],
        minimumContext: Math.min(entry!.contextWindow, 32_000)
      };
      const selected = new CapabilityRouter([route]).resolve(makeTask({ requirements }));

      expect(selected.id).toBe(entry!.id);
      expect(selected.capabilities.contextTokens).toBe(entry!.contextWindow);
      expect(selected.capabilities.maxOutputTokens).toBe(entry!.maxTokens);
    }
  });

  it('selects a reasoning-capable route across providers and rejects a strict mismatch before queueing', () => {
    const routes = REPRESENTATIVE_MODELS.map((model) => {
      const entry = findModelInCatalog(model.id);
      expect(entry).toBeDefined();
      return routeFromCatalog(entry!);
    });
    const selected = new CapabilityRouter(routes).resolve(
      makeTask({ requirements: { needsReasoning: true, outputFormats: ['text'] } })
    );
    expect(selected.capabilities.reasoning).toBe(true);

    const plainModel = findModelInCatalog('deepseek/deepseek-chat');
    expect(plainModel).toBeDefined();
    expect(() =>
      new CapabilityRouter([routeFromCatalog(plainModel!)]).resolve(
        makeTask({ requirements: { needsReasoning: true, outputFormats: ['text'] } })
      )
    ).toThrow(CapabilityMismatchError);
  });

  it('uses explicit catalog overrides for structured output and builds a strict contract', () => {
    const entry: ModelCatalogEntry = {
      id: 'custom/structured-author',
      name: 'Structured author',
      provider: 'custom',
      contextWindow: 32_000,
      maxTokens: 4_000,
      supportsThinking: true,
      supportsTools: true,
      supportsVision: false,
      cost: { inputPerMillionUsd: 0, outputPerMillionUsd: 0 },
      capabilities: {
        network: 'optional',
        outputFormats: ['text', 'structured'],
        structuredOutput: true,
        jsonSchema: true
      }
    };
    expect(modelCatalogEntryToCapabilityDeclaration(entry)).toMatchObject({
      network: 'optional',
      outputFormats: ['text', 'structured'],
      structuredOutput: true,
      jsonSchema: true,
      tools: true,
      reasoning: true
    });

    const route = routeFromCatalog(entry);
    const selected = new CapabilityRouter([route]).resolve(
      makeTask({
        outputContract: { format: 'structured', schemaId: 'story.schema' },
        requirements: {
          network: 'optional',
          outputFormats: ['structured'],
          needsStructuredOutput: true,
          needsTools: true,
          needsReasoning: true
        }
      })
    );
    expect(selected.id).toBe(entry.id);
  });

  it('accepts an offline route when network access is optional', () => {
    const local = findModelInCatalog('ollama/qwen2.5:14b');
    expect(local).toBeDefined();
    expect(
      new CapabilityRouter([routeFromCatalog(local!)]).resolve(
        makeTask({ requirements: { network: 'optional', outputFormats: ['text'] } })
      ).id
    ).toBe(local!.id);
  });

  it('does not expose test-only faux models through the production catalog', () => {
    expect(KNOWN_MODELS.every((model) => model.provider !== 'faux' && !model.id.startsWith('mock/'))).toBe(true);
  });
});
