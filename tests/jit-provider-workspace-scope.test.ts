import type { AiTask, JitContextQuery } from '@inkpi/protocol';
import { JitContextProvider } from '@inkpi/server';
import type { JitMemoryRetriever } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// JIT retrieval refuses to run without a workspace (INV-03, plan P0.11)
//
// The retriever's L2/L3 tiers read the shared SQLite store. When the query
// carries no workspaceId, the storage layer falls back to an unscoped match,
// so text from a *different* project would be injected as "full text match"
// context for this task. The provider is the last place that still knows which
// workspace the task belongs to, so the fail-closed decision lives here.
// ---------------------------------------------------------------------------

function blankResult() {
  return {
    l1WorkingMemory: { activeLedger: {}, activeReferences: [], activeEntities: [], activeAssets: [] },
    l2RecentSummaries: [],
    l3GlobalLore: [],
    assembledPromptBlock: ''
  } as never;
}

function loreResult(documentId: string) {
  const result = blankResult() as Record<string, unknown>;
  result.l3GlobalLore = [{ documentId, title: '隔壁项目的章节', snippet: '不属于这个作品', rank: 1 }];
  return result as never;
}

function stubRetriever(result: unknown = blankResult()) {
  const retrieve = vi.fn(async (_query: JitContextQuery) => result);
  return { retrieve, retriever: { retrieve } as unknown as JitMemoryRetriever };
}

function taskIn(workspaceId?: string): AiTask {
  const base: AiTask = {
    id: 'jit-scope-task',
    kind: 'creative.continue',
    input: { text: '船队收回了那座古老的信标。', documentId: 'chapter-1' }
  };
  return workspaceId ? { ...base, scope: { workspaceId, workspaceRevision: 4 } } : base;
}

describe('JitContextProvider workspace scoping', () => {
  it('不给没有 workspace 归属的任务跑检索，也不留下可复用的缓存', async () => {
    const { retrieve, retriever } = stubRetriever(loreResult('other-workspace-chapter'));
    const provider = new JitContextProvider(retriever);

    const fragments = await provider.provide({ task: taskIn(), projectRevision: 4 });

    expect(fragments).toEqual([]);
    expect(retrieve).not.toHaveBeenCalled();
    expect(provider.cacheStats()).toMatchObject({ hits: 0, misses: 0 });
  });

  it('有 scope 时把同一个 workspaceId 交给检索层', async () => {
    const { retrieve, retriever } = stubRetriever(loreResult('chapter-2'));
    const provider = new JitContextProvider(retriever);

    const fragments = await provider.provide({ task: taskIn('ws-a'), projectRevision: 4 });

    expect(retrieve).toHaveBeenCalledTimes(1);
    expect(retrieve.mock.calls[0][0]).toMatchObject({ workspaceId: 'ws-a' });
    expect(fragments).toHaveLength(1);
    expect(fragments[0].data).toMatchObject({
      fullTextMatches: [{ documentId: 'chapter-2' }]
    });
  });

  it('空白 workspaceId 不算归属，不能退化成全库检索', async () => {
    const { retrieve, retriever } = stubRetriever();
    const provider = new JitContextProvider(retriever);
    const task: AiTask = {
      id: 'jit-scope-task',
      kind: 'creative.continue',
      input: { text: '信标。', payload: { workspaceId: '   ' } }
    };

    const fragments = await provider.provide({ task, projectRevision: 4 });

    expect(fragments).toEqual([]);
    expect(retrieve).not.toHaveBeenCalled();
  });

  it('已缓存的作品上下文不会借给下一个无归属任务', async () => {
    const { retriever } = stubRetriever(loreResult('chapter-2'));
    const provider = new JitContextProvider(retriever);

    await provider.provide({ task: taskIn('ws-a'), projectRevision: 4 });
    const unscoped = await provider.provide({ task: taskIn(), projectRevision: 4 });

    expect(unscoped).toEqual([]);
    expect(provider.cacheStats().misses).toBe(1);
  });
});
