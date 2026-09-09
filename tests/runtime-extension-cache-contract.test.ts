import {
  ContextPipeline,
  ExtensionHost,
  ProgressiveSkillRuntime,
  RuntimeCacheCoordinator,
  ToolRegistry,
  createContextCacheKey,
  stableSerialize
} from '@inkpi/agent-core';
import type { AgentTool, AiTask, SkillInfo } from '@inkpi/protocol';
import { createRetrievalCacheKey, JitContextProvider } from '@inkpi/server';
import type { JitMemoryRetriever } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';

function makeTask(revision = 7, id = 'contract-task'): AiTask {
  return {
    id,
    kind: 'contract.test',
    input: {
      documentId: 'contract-document',
      selection: { documentId: 'contract-document', from: 0, to: 4, revision },
      text: 'stable context input',
      payload: { workspaceId: 'contract-workspace', activeReferences: ['beacon'] }
    },
    contextPolicy: { providerIds: ['static', 'retrieval.jit'], maxTokens: 1024 },
    outputContract: { format: 'text' }
  };
}

function emptyLedger() {
  return { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] };
}

describe('Runtime extension and cache boundary contracts', () => {
  it('binds skill capabilities to shared tool registries and emits a process-safe snapshot', async () => {
    const extensionHost = new ExtensionHost();
    const toolRegistry = new ToolRegistry();
    const skill: SkillInfo = {
      name: 'contract-skill',
      description: 'Contract skill',
      filePath: 'contract-skill.md',
      frontmatter: {
        id: 'contract-skill',
        version: '2.1.0',
        capabilities: ['z-capability', 'tool.invoke', 'tool.invoke'],
        activation: 'lazy'
      },
      promptBody: 'private prompt body must stay local'
    };
    const tool: AgentTool = {
      name: 'contract-tool',
      description: 'Runtime-owned tool',
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] })
    };
    const runtime = new ProgressiveSkillRuntime({ extensionHost, toolRegistry });
    runtime.registerSkill(skill, ({ registerTool }) => registerTool(tool));

    await runtime.activate(skill.name);

    const snapshot = runtime.getRegistrationSnapshot();
    const wireSnapshot = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    expect(wireSnapshot.skills[0]).toMatchObject({
      id: 'contract-skill',
      version: '2.1.0',
      capabilities: ['z-capability', 'tool.invoke']
    });
    expect(JSON.stringify(wireSnapshot)).not.toContain('private prompt body');
    expect(wireSnapshot.tools).toEqual([
      {
        name: 'contract-tool',
        source: 'skill',
        skillId: 'contract-skill',
        skillVersion: '2.1.0',
        capabilities: ['tool.invoke', 'z-capability']
      }
    ]);
    expect(wireSnapshot.tools[0]).not.toHaveProperty('execute');
    expect(extensionHost.getToolRegistrations()).toEqual(wireSnapshot.tools);
    expect(toolRegistry.getByCapabilities(['tool.invoke'])).toEqual([tool]);
    expect(toolRegistry.getByCapabilities(['missing.capability'])).toEqual([]);
  });

  it('uses canonical, revision-aware identities across context and retrieval layers', () => {
    const first = makeTask(7, 'first-task');
    const equivalent = {
      ...makeTask(7, 'second-task'),
      input: {
        payload: { activeReferences: ['beacon'], workspaceId: 'contract-workspace' },
        text: 'stable context input',
        selection: { to: 4, from: 0, revision: 7, documentId: 'contract-document' },
        documentId: 'contract-document'
      }
    } satisfies AiTask;

    expect(stableSerialize({ b: 2, a: 1 })).toBe(stableSerialize({ a: 1, b: 2 }));
    expect(createContextCacheKey(first, ['static', 'retrieval.jit'], 1024)).toBe(
      createContextCacheKey(equivalent, ['static', 'retrieval.jit'], 1024)
    );
    expect(createContextCacheKey(first, ['static', 'retrieval.jit'], 1024)).not.toBe(
      createContextCacheKey(makeTask(8), ['static', 'retrieval.jit'], 1024)
    );

    const query = {
      workspaceId: 'contract-workspace',
      currentDocumentId: 'contract-document',
      currentText: 'stable context input',
      activeReferences: ['beacon']
    };
    expect(
      createRetrievalCacheKey(query, 7, {
        purpose: 'contract.test',
        metadata: { model: 'model-a', skillVersion: 'skill-1', instructionVersion: 'instruction-1' }
      })
    ).toBe(
      createRetrievalCacheKey(query, 7, {
        purpose: 'contract.test',
        metadata: { instructionVersion: 'instruction-1', skillVersion: 'skill-1', model: 'model-a' }
      })
    );
    expect(createRetrievalCacheKey(query, 7)).not.toBe(createRetrievalCacheKey(query, 8));
  });

  it('invalidates context and retrieval caches together and aggregates all three layer metrics', async () => {
    const coordinator = new RuntimeCacheCoordinator();
    const contextProvider = {
      id: 'static',
      provide: vi.fn(() => [{ id: 'static-fragment', source: 'static', text: 'stable fragment' }])
    };
    const retriever = {
      retrieve: vi.fn(async () => ({
        l1WorkingMemory: {
          activeLedger: emptyLedger(),
          activeReferences: ['beacon'],
          activeEntities: [],
          activeAssets: []
        },
        l2RecentSummaries: [{ documentId: 'previous', title: 'Previous', summary: 'prior context' }],
        l3GlobalLore: [],
        assembledPromptBlock: ''
      }))
    } as unknown as JitMemoryRetriever;
    const pipeline = new ContextPipeline({ cacheCoordinator: coordinator });
    const provider = new JitContextProvider(retriever, { cacheCoordinator: coordinator });
    pipeline.register(contextProvider);
    pipeline.register(provider);

    await pipeline.build(makeTask(7, 'first-task'));
    await pipeline.build(makeTask(7, 'equivalent-task'));
    expect(contextProvider.provide).toHaveBeenCalledTimes(1);
    expect(retriever.retrieve).toHaveBeenCalledTimes(1);

    pipeline.clearCache();
    await pipeline.build(makeTask(7, 'after-context-clear'));
    expect(contextProvider.provide).toHaveBeenCalledTimes(2);
    expect(retriever.retrieve).toHaveBeenCalledTimes(1);

    coordinator.record('provider', 'hit');
    coordinator.record('provider', 'miss');
    coordinator.invalidate({ reason: 'revision', projectRevision: 8 });

    await pipeline.build(makeTask(8, 'after-revision'));
    expect(retriever.retrieve).toHaveBeenCalledTimes(2);
    expect(provider.cacheStats()).toMatchObject({ hits: 1, misses: 2, invalidations: 1 });
    expect(pipeline.cacheStats()).toMatchObject({ hits: 1, misses: 3, invalidations: 2 });
    expect(coordinator.stats()).toEqual({
      provider: { hits: 1, misses: 1, evictions: 0, invalidations: 1 },
      context: { hits: 1, misses: 3, evictions: 0, invalidations: 1 },
      retrieval: { hits: 1, misses: 2, evictions: 0, invalidations: 1 }
    });

    pipeline.dispose();
    provider.dispose();
  });
});
