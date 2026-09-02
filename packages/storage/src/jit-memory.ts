import type { FtsSearchResult, JitContextQuery, JitContextResult, StateLedger } from '@inkpi/protocol';
import type { FtsSearchEngine } from './fts.js';
import type { InkRepository } from './repository.js';

export interface JitMemoryRetrieverOptions {
  repository: InkRepository;
  ftsEngine: FtsSearchEngine;
  /** Select domain-specific retrieval terms from the query and active ledger. */
  keywordSelector?: (
    query: JitContextQuery,
    activeLedger: StateLedger,
    activeEntities: string[],
    activeAssets: string[]
  ) => string[];
  /** Format the structured retrieval result for a downstream consumer. */
  formatContext?: (result: Omit<JitContextResult, 'assembledPromptBlock'>) => string;
  /** Decide what to do when a real FTS search fails. Defaults to throwing. */
  onSearchError?: 'throw' | 'ignore' | ((error: unknown, keyword: string) => void);
}

/**
 * JIT 分层检索管理器。
 * 核心只负责从结构化状态、近期文档和全文索引中检索数据；提示词格式由调用方选择。
 */
export class JitMemoryRetriever {
  private repo: InkRepository;
  private fts: FtsSearchEngine;
  private keywordSelector: NonNullable<JitMemoryRetrieverOptions['keywordSelector']>;
  private formatContext?: JitMemoryRetrieverOptions['formatContext'];
  private onSearchError: NonNullable<JitMemoryRetrieverOptions['onSearchError']>;

  constructor(options: JitMemoryRetrieverOptions) {
    this.repo = options.repository;
    this.fts = options.ftsEngine;
    this.keywordSelector = options.keywordSelector || defaultKeywordSelector;
    this.formatContext = options.formatContext;
    this.onSearchError = options.onSearchError || 'throw';
  }

  /**
   * 执行 JIT 3 级分层记忆装配
   */
  public async retrieve(query: JitContextQuery, currentLedger?: StateLedger): Promise<JitContextResult> {
    // -------------------------------------------------------------
    // L1: 工作记忆 (Working Memory)
    // -------------------------------------------------------------
    const activeLedger: StateLedger = currentLedger || {
      entities: [],
      assets: [],
      tracks: [],
      locations: [],
      modifiedResources: []
    };

    const suppliedReferences = query.activeReferences || query.activeEntities || [];
    const textToScan = `${query.currentText || query.currentDraftText || ''} ${suppliedReferences.join(' ')}`;
    const activeEntities = (activeLedger.entities || [])
      .filter((c: StateLedger['entities'][number]) => textToScan.includes(c.name))
      .map((c: StateLedger['entities'][number]) => c.name);

    const activeAssets = (activeLedger.assets || [])
      .filter((i: StateLedger['assets'][number]) => textToScan.includes(i.name))
      .map((i: StateLedger['assets'][number]) => i.name);

    // -------------------------------------------------------------
    // L2: Recent document summaries
    // -------------------------------------------------------------
    const l2RecentSummaries: Array<{ documentId: string; title: string; summary: string }> = [];
    if (query.workspaceId) {
      const folders = this.repo.getFolders(query.workspaceId);
      const allDocuments: Array<{ id: string; title: string; orderIndex: number; synopsis?: string }> = [];

      for (const vol of folders) {
        const chs = this.repo.getDocuments(vol.id);
        allDocuments.push(...chs);
      }

      allDocuments.sort((a, b) => a.orderIndex - b.orderIndex);

      // Retrieve the nearest preceding documents by their explicit order.
      let targetIndex = allDocuments.length;
      if (query.currentDocumentId) {
        const idx = allDocuments.findIndex((c) => c.id === query.currentDocumentId);
        if (idx !== -1) targetIndex = idx;
      }

      const maxSummaries = query.maxSummaryDocuments ?? 3;
      const startIdx = Math.max(0, targetIndex - maxSummaries);
      const recentChs = allDocuments.slice(startIdx, targetIndex);

      for (const ch of recentChs) {
        if (ch.synopsis && ch.synopsis.trim().length > 0) {
          l2RecentSummaries.push({
            documentId: ch.id,
            title: ch.title,
            summary: ch.synopsis.trim()
          });
        }
      }
    }

    // -------------------------------------------------------------
    // L3: Full-text retrieval
    // -------------------------------------------------------------
    const l3GlobalLore: FtsSearchResult[] = [];
    const uniqueKeywords = Array.from(new Set(this.keywordSelector(query, activeLedger, activeEntities, activeAssets)))
      .filter((k) => typeof k === 'string' && k.trim().length >= 2)
      .map((k) => k.trim());

    if (uniqueKeywords.length > 0) {
      for (const kw of uniqueKeywords.slice(0, 5)) {
        try {
          const searchResults = this.fts.search(kw, query.maxFtsResults ?? 4);
          for (const res of searchResults) {
            if (query.currentDocumentId && res.documentId === query.currentDocumentId) {
              continue; // 过滤当前正在编辑的文档自身
            }
            if (!l3GlobalLore.some((item) => item.documentId === res.documentId)) {
              l3GlobalLore.push(res);
            }
          }
        } catch (err) {
          if (this.onSearchError === 'throw') throw err;
          if (this.onSearchError === 'ignore') continue;
          this.onSearchError(err, kw);
        }
      }
    }

    const structuredResult = {
      l1WorkingMemory: {
        activeLedger,
        activeReferences: [...new Set([...activeEntities, ...activeAssets])],
        activeEntities,
        activeAssets
      },
      l2RecentSummaries,
      l3GlobalLore
    };

    return {
      ...structuredResult,
      assembledPromptBlock: this.formatContext ? this.formatContext(structuredResult) : ''
    };
  }
}

function defaultKeywordSelector(
  query: JitContextQuery,
  _activeLedger: StateLedger,
  activeEntities: string[],
  activeAssets: string[]
): string[] {
  return [...(query.activeReferences || query.activeEntities || []), ...activeEntities, ...activeAssets];
}

/** Optional neutral text formatter for consumers that need a prompt block. */
export function formatJitContextAsPrompt(result: Omit<JitContextResult, 'assembledPromptBlock'>): string {
  const sections: string[] = ['=== Retrieved Context: Working State ==='];
  const { activeLedger } = result.l1WorkingMemory;
  if (activeLedger.entities?.length) {
    sections.push(
      `Entities: ${activeLedger.entities.map((entity) => `${entity.name}${entity.status ? `(${entity.status})` : ''}`).join(', ')}`
    );
  }
  if (activeLedger.assets?.length) {
    sections.push(
      `Assets: ${activeLedger.assets.map((asset) => `${asset.name}${asset.holder ? `[Holder:${asset.holder}]` : ''}`).join(', ')}`
    );
  }
  if (activeLedger.tracks?.length) {
    sections.push(
      `Tracks: ${activeLedger.tracks.map((track) => `${track.clue || track.summary || track.id || 'track'}${track.status ? `(${track.status})` : ''}`).join('; ')}`
    );
  }
  if (result.l2RecentSummaries.length) {
    sections.push('=== Recent Document Summaries ===');
    for (const item of result.l2RecentSummaries) sections.push(`[${item.title}]: ${item.summary}`);
  }
  if (result.l3GlobalLore.length) {
    sections.push('=== Full-Text Matches ===');
    for (const item of result.l3GlobalLore) sections.push(`[${item.title}]: ${item.snippet.replace(/\n+/g, ' ')}`);
  }
  return sections.join('\n');
}
