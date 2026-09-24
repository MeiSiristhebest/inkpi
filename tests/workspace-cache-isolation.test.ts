import {
  ContextPipeline,
  type TaskHandlerContext,
  createContextCacheKey,
  resolveTaskWorkspaceId
} from '@inkpi/agent-core';
import { AssistantEventStream, type ModelConfig } from '@inkpi/ai';
import type { AgentMessage, AiTask } from '@inkpi/protocol';
import { JitContextProvider, TaskModelHandler, createRetrievalCacheKey } from '@inkpi/server';
import type { JitMemoryRetriever } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Workspace isolation for every Runtime cache layer (INV-03)
//
// A cached packet, retrieval result, or provider reply is derived from one
// workspace's material, so replaying it into another workspace crosses the
// only isolation boundary the product has. Each layer's canonical key must
// therefore carry the owning workspace id — including when a caller pins one
// context fingerprint for both.
// ---------------------------------------------------------------------------

const model: ModelConfig = { id: 'workspace-isolation-model', name: 'Isolation model', provider: 'faux' };

function scopedTask(workspaceId: string | undefined, carrier: 'scope' | 'payload' | 'metadata'): AiTask {
  const base: AiTask = {
    id: 'isolation-task',
    kind: 'creative.continue',
    input: { text: 'the same opening line', documentId: 'chapter-1' }
  };
  if (!workspaceId) return base;
  if (carrier === 'scope') {
    return { ...base, scope: { workspaceId, workspaceRevision: 4 } };
  }
  if (carrier === 'payload') {
    return { ...base, input: { ...base.input, payload: { workspaceId } } };
  }
  return { ...base, metadata: { workspaceId } };
}

function blankScopedTask(): AiTask {
  const base = scopedTask('ws-a', 'payload');
  return { ...base, input: { ...base.input, payload: { workspaceId: '   ' } } };
}

function handlerContext(task: AiTask, runId: string): TaskHandlerContext {
  return {
    task,
    context: {
      fragments: [],
      text: '',
      tokenEstimate: 0,
      fingerprint: 'shared-context-fingerprint',
      truncated: false,
      projectRevision: 4
    },
    signal: new AbortController().signal,
    executionRunId: `run:${runId}`,
    attempt: 1,
    consumeSteering: () => [],
    saveCheckpoint: async () => undefined,
    reportProgress: () => undefined
  };
}

describe('Runtime cache workspace isolation', () => {
  it('resolves the owning workspace from scope first, then the payload and metadata carriers', () => {
    const resolved = 'ws-a';
    expect(resolveTaskWorkspaceId(scopedTask(resolved, 'scope'))).toBe(resolved);
    expect(resolveTaskWorkspaceId(scopedTask(resolved, 'payload'))).toBe(resolved);
    expect(resolveTaskWorkspaceId(scopedTask(resolved, 'metadata'))).toBe(resolved);
    expect(resolveTaskWorkspaceId(scopedTask(undefined, 'scope'))).toBeNull();
    expect(resolveTaskWorkspaceId(blankScopedTask())).toBeNull();
  });

  it('keys compiled context by workspace even when the caller pins one context fingerprint', () => {
    const pinned = (workspaceId: string): AiTask => ({
      ...scopedTask(workspaceId, 'scope'),
      metadata: { contextFingerprint: 'pinned-across-workspaces' }
    });

    const keyA = createContextCacheKey(pinned('ws-a'), ['static'], 1024);
    expect(keyA).toBe(createContextCacheKey(pinned('ws-a'), ['static'], 1024));
    expect(keyA).not.toBe(createContextCacheKey(pinned('ws-b'), ['static'], 1024));
    expect(keyA).not.toContain('the same opening line');
  });

  it('never lets a second workspace or an unscoped request reuse a cached context packet', async () => {
    const provider = {
      id: 'static',
      provide: vi.fn(() => [{ id: 'fragment', source: 'static', text: 'workspace material' }])
    };
    const pipeline = new ContextPipeline();
    pipeline.register(provider);

    await pipeline.build(scopedTask('ws-a', 'scope'));
    await pipeline.build(scopedTask('ws-a', 'scope'));
    expect(provider.provide).toHaveBeenCalledTimes(1);

    await pipeline.build(scopedTask('ws-b', 'scope'));
    expect(provider.provide).toHaveBeenCalledTimes(2);

    await pipeline.build(scopedTask(undefined, 'scope'));
    expect(provider.provide).toHaveBeenCalledTimes(3);
  });

  it('keys JIT retrieval by the workspace the query actually ran against', () => {
    const retrievalKey = (workspaceId?: string) =>
      createRetrievalCacheKey(
        { workspaceId, currentDocumentId: 'chapter-1', currentText: 'the same opening line' },
        4,
        { purpose: 'creative.continue' }
      );

    expect(retrievalKey('ws-a')).toBe(retrievalKey('ws-a'));
    expect(retrievalKey('ws-a')).not.toBe(retrievalKey('ws-b'));
    expect(retrievalKey()).not.toBe(retrievalKey('ws-a'));
  });

  it('scopes JIT retrieval to the task workspace instead of searching every workspace', async () => {
    const retrieve = vi.fn(async () => ({
      l1WorkingMemory: {
        activeLedger: {},
        activeReferences: [],
        activeEntities: [],
        activeAssets: []
      },
      l2RecentSummaries: [],
      l3GlobalLore: [],
      assembledPromptBlock: ''
    }));
    const provider = new JitContextProvider({ retrieve } as unknown as JitMemoryRetriever);

    await provider.provide({ task: scopedTask('ws-a', 'scope') });
    await provider.provide({ task: scopedTask('ws-a', 'scope') });
    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-a' }));

    await provider.provide({ task: scopedTask('ws-b', 'scope') });
    expect(retrieve).toHaveBeenCalledTimes(2);
    expect(retrieve).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'ws-b' }));
  });

  it('does not replay a cached provider reply into another workspace', async () => {
    const stream = vi.fn((_model: ModelConfig, _messages: AgentMessage[]) => {
      const result = new AssistantEventStream();
      queueMicrotask(() => {
        result.push({ type: 'text_delta', textDelta: 'a continuation' });
        result.end();
      });
      return result;
    });
    const handler = new TaskModelHandler({
      model,
      stream,
      defaultModelCapabilities: { outputFormats: ['text'], structuredOutput: false }
    });

    await handler.execute(handlerContext(scopedTask('ws-a', 'scope'), 'first'));
    await handler.execute(handlerContext(scopedTask('ws-a', 'scope'), 'repeat'));
    expect(stream).toHaveBeenCalledTimes(1);

    await handler.execute(handlerContext(scopedTask('ws-b', 'scope'), 'other-workspace'));
    expect(stream).toHaveBeenCalledTimes(2);

    await handler.execute(handlerContext(scopedTask(undefined, 'scope'), 'unscoped'));
    expect(stream).toHaveBeenCalledTimes(3);
  });
});
