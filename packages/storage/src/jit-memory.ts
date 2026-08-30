import type {
  StateLedger,
  FtsSearchResult,
  JitContextQuery,
  JitContextResult
} from '@inkpi/protocol';
import type { InkRepository } from './repository.js';
import type { FtsSearchEngine } from './fts.js';

export interface JitMemoryRetrieverOptions {
  repository: InkRepository;
  ftsEngine: FtsSearchEngine;
}

/**
 * JIT 分层检索记忆管理器 (1:1 对标工业级 long-context 智能检索架构)
 * 包含 L1 工作记忆 (内存状态账本) -> L2 近期剧情链条 (章节摘要) -> L3 全局长线记忆 (FTS5 全文召回)
 */
export class JitMemoryRetriever {
  private repo: InkRepository;
  private fts: FtsSearchEngine;

  constructor(options: JitMemoryRetrieverOptions) {
    this.repo = options.repository;
    this.fts = options.ftsEngine;
  }

  /**
   * 执行 JIT 3 级分层记忆装配
   */
  public async retrieve(
    query: JitContextQuery,
    currentLedger?: StateLedger
  ): Promise<JitContextResult> {
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

    const textToScan = `${query.currentDraftText || ''} ${(query.activeEntities || []).join(' ')}`;
    const activeEntities = (activeLedger.entities || [])
      .filter((c: StateLedger['entities'][number]) => textToScan.includes(c.name))
      .map((c: StateLedger['entities'][number]) => c.name);

    const activeAssets = (activeLedger.assets || [])
      .filter((i: StateLedger['assets'][number]) => textToScan.includes(i.name))
      .map((i: StateLedger['assets'][number]) => i.name);

    // -------------------------------------------------------------
    // L2: 近期剧情概要链 (Recent Document Summaries)
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

      // 提取当前章节之前的最近 N 个章节摘要
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
    // L3: 全局长线记忆 (FTS5 Global Lore Retrieval)
    // -------------------------------------------------------------
    const l3GlobalLore: FtsSearchResult[] = [];
    const keywords: string[] = [];

    if (query.activeEntities && query.activeEntities.length > 0) {
      keywords.push(...query.activeEntities);
    }
    if (activeEntities.length > 0) {
      keywords.push(...activeEntities);
    }
    if (activeAssets.length > 0) {
      keywords.push(...activeAssets);
    }

    const uniqueKeywords = Array.from(new Set(keywords)).filter((k) => k.length >= 2);

    if (uniqueKeywords.length > 0) {
      for (const kw of uniqueKeywords.slice(0, 5)) {
        try {
          const searchResults = this.fts.search(kw, query.maxFtsResults ?? 4);
          for (const res of searchResults) {
            if (query.currentDocumentId && res.documentId === query.currentDocumentId) {
              continue; // 过滤当前正在编辑的章节自身
            }
            if (!l3GlobalLore.some((item) => item.documentId === res.documentId)) {
              l3GlobalLore.push(res);
            }
          }
        } catch (err) {
          console.error('[JitMemoryRetriever] FTS search error:', err);
        }
      }
    }

    // -------------------------------------------------------------
    // 组装格式化 JIT Prompt 块
    // -------------------------------------------------------------
    const sections: string[] = [];

    // 1. L1 Block
    sections.push('=== 🧠 [L1 Working Memory: Active Entities and Items] ===');
    if (activeLedger.entities && activeLedger.entities.length > 0) {
      sections.push(`Active Entities: ${activeLedger.entities.map((c: StateLedger['entities'][number]) => `${c.name}${c.status ? `(${c.status})` : ''}`).join(', ')}`);
    }
    if (activeLedger.assets && activeLedger.assets.length > 0) {
      sections.push(`Key Items: ${activeLedger.assets.map((i: StateLedger['assets'][number]) => `${i.name}${i.holder ? `[Holder:${i.holder}]` : ''}`).join(', ')}`);
    }
    const pendingForeshadows = (activeLedger.tracks || []).filter((f: StateLedger['tracks'][number]) => f.status === 'pending');
    if (pendingForeshadows.length > 0) {
      sections.push(`Pending Conditions: ${pendingForeshadows.map((f: StateLedger['tracks'][number]) => f.clue).join('; ')}`);
    }

    // 2. L2 Block
    if (l2RecentSummaries.length > 0) {
      sections.push('\n=== 📜 [L2 Document Chain: Recent Summaries] ===');
      for (const s of l2RecentSummaries) {
        sections.push(`• [${s.title}]: ${s.summary}`);
      }
    }

    // 3. L3 Block
    if (l3GlobalLore.length > 0) {
      sections.push('\n=== 🔍 [L3 Global Lore & Long-term Context (FTS5 Retrieval)] ===');
      for (const lore of l3GlobalLore) {
        sections.push(`• History snippet from [${lore.title}]: "${lore.snippet.replace(/\\n+/g, ' ')}"`);
      }
    }

    const assembledPromptBlock = sections.join('\n');

    return {
      l1WorkingMemory: {
        activeLedger,
        activeEntities,
        activeAssets
      },
      l2RecentSummaries,
      l3GlobalLore,
      assembledPromptBlock
    };
  }
}
