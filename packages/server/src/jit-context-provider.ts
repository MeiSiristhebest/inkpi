import type { ContextFragment, ContextProvider, ContextRequest } from '@inkpi/agent-core';
import type { JitContextQuery } from '@inkpi/protocol';
import type { JitMemoryRetriever } from '@inkpi/storage';

/** Adapts the existing JIT retriever to the generic context pipeline. */
export class JitContextProvider implements ContextProvider {
  readonly id = 'retrieval.jit';

  constructor(private readonly retriever: JitMemoryRetriever) {}

  async provide(request: ContextRequest): Promise<ContextFragment[]> {
    const payload = request.task.input.payload;
    const values = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
    const metadata = request.metadata ?? {};
    const query: JitContextQuery = {
      workspaceId: firstString(values.workspaceId, metadata.workspaceId),
      currentDocumentId: request.task.input.documentId,
      currentText: request.task.input.text,
      activeReferences: asStringArray(values.activeReferences),
      maxSummaryDocuments: asNumber(values.maxSummaryDocuments),
      maxFtsResults: asNumber(values.maxFtsResults),
    };
    const result = await this.retriever.retrieve(query);
    if (
      !result.l2RecentSummaries.length &&
      !result.l3GlobalLore.length &&
      !result.l1WorkingMemory.activeReferences.length
    ) {
      return [];
    }
    return [
      {
        id: `jit:${request.task.id}:${request.projectRevision ?? 0}`,
        source: this.id,
        kind: 'retrieval-result',
        data: {
          workingMemory: result.l1WorkingMemory,
          recentSummaries: result.l2RecentSummaries,
          fullTextMatches: result.l3GlobalLore,
        },
        priority: 500,
      },
    ];
  }
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function asStringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string') ? [...value] : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
