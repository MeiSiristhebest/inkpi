import type { StateLedger } from '@inkpi/protocol';
import { SessionTree, type SessionTreeNode } from './tree.js';
import { BranchSummarizer } from './branch-summary.js';

export interface WhatIfBranchInfo {
  branchId: string;
  branchName: string;
  premise: string; // "What if condition..."
  forkPointNodeId: string;
  currentLeafId: string;
  createdAt: number;
  stateLedger: StateLedger;
  documentSnapshots?: Record<string, string>; // documentId -> content
}

export interface LedgerDiffResult {
  addedEntities: string[];
  changedEntityStatuses: Array<{ name: string; from?: string; to?: string }>;
  addedAssets: string[];
  newTracks: string[];
  resolvedTracks: string[];
}

export interface DocumentDiffResult {
  modifiedDocuments: Array<{
    documentId: string;
    charsDelta: number;
    linesAdded: number;
    linesRemoved: number;
  }>;
}

export interface WhatIfExecutiveReport {
  baseBranchName: string;
  targetBranchName: string;
  premise: string;
  ledgerDiff: LedgerDiffResult;
  documentDiff?: DocumentDiffResult;
  executiveSummary: string;
}

/**
 * 通用多线推演管理器 (1:1 落地 repos/pi SessionTree & Branch Summarization 架构)
 * 允许在任意节点开辟平行时间线，进行 What-If 假设推演、自动对比状态账本与文档差异。
 */
export class BranchManager {
  private tree: SessionTree;
  private summarizer: BranchSummarizer;
  private branches = new Map<string, WhatIfBranchInfo>();
  private activeBranchId = 'main';

  constructor(tree?: SessionTree, summarizer?: BranchSummarizer) {
    this.tree = tree || new SessionTree();
    this.summarizer = summarizer || new BranchSummarizer();

    // 默认主线分支
    this.branches.set('main', {
      branchId: 'main',
      branchName: '主线 (Mainline)',
      premise: '标准主线进程',
      forkPointNodeId: 'root',
      currentLeafId: this.tree.getCurrentLeafId() || 'root',
      createdAt: Date.now(),
      stateLedger: {
        entities: [],
        assets: [],
        tracks: [],
        locations: [],
        modifiedResources: []
      },
      documentSnapshots: {}
    });
  }

  public getTree(): SessionTree {
    return this.tree;
  }

  public getActiveBranchId(): string {
    return this.activeBranchId;
  }

  public getAllBranches(): WhatIfBranchInfo[] {
    return Array.from(this.branches.values());
  }

  public getBranch(branchId: string): WhatIfBranchInfo | undefined {
    return this.branches.get(branchId);
  }

  /**
   * 从当前节点（或指定节点）分叉出一条新的 What-If 推演分支
   */
  public createWhatIfBranch(
    branchId: string,
    branchName: string,
    premise: string,
    initialLedger?: StateLedger,
    initialDocuments?: Record<string, string>
  ): WhatIfBranchInfo {
    const currentLeaf = this.tree.getCurrentLeafId() || 'root';
    const activeBranch = this.branches.get(this.activeBranchId);

    const ledger: StateLedger = initialLedger
      ? { ...initialLedger }
      : activeBranch
      ? JSON.parse(JSON.stringify(activeBranch.stateLedger))
      : { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] };

    const docs: Record<string, string> = initialDocuments
      ? { ...initialDocuments }
      : activeBranch?.documentSnapshots
      ? { ...activeBranch.documentSnapshots }
      : {};

    const branchInfo: WhatIfBranchInfo = {
      branchId,
      branchName,
      premise,
      forkPointNodeId: currentLeaf,
      currentLeafId: currentLeaf,
      createdAt: Date.now(),
      stateLedger: ledger,
      documentSnapshots: docs
    };

    this.branches.set(branchId, branchInfo);
    return branchInfo;
  }

  /**
   * 切换至指定分支，并在分叉处生成并注入分支差异摘要
   */
  public async switchBranch(targetBranchId: string): Promise<{
    switched: boolean;
    branch: WhatIfBranchInfo;
    summary?: string;
  }> {
    const target = this.branches.get(targetBranchId);
    if (!target) {
      throw new Error(`Branch not found: ${targetBranchId}`);
    }

    const currentBranch = this.branches.get(this.activeBranchId);
    if (currentBranch) {
      currentBranch.currentLeafId = this.tree.getCurrentLeafId() || currentBranch.currentLeafId;
    }

    let summaryText: string | undefined;

    if (currentBranch && currentBranch.branchId !== targetBranchId) {
      const diff = this.diffLedgers(currentBranch.stateLedger, target.stateLedger);
      summaryText = `【分支切换: ${currentBranch.branchName} -> ${target.branchName}】\n` +
        `分支假设: ${target.premise}\n` +
        `主要实体状态差异: ${diff.changedEntityStatuses.map((c) => `${c.name}: ${c.from || '无'} -> ${c.to || '无'}`).join('；') || '无明显变动'}\n` +
        `新增登场: ${diff.addedEntities.join('、') || '无'}`;
    }

    this.activeBranchId = targetBranchId;
    if (target.currentLeafId && target.currentLeafId !== 'root') {
      this.tree.navigate(target.currentLeafId);
    }

    return {
      switched: true,
      branch: target,
      summary: summaryText
    };
  }

  /**
   * 更新当前分支的状态账本
   */
  public updateActiveLedger(ledger: StateLedger): void {
    const active = this.branches.get(this.activeBranchId);
    if (active) {
      active.stateLedger = JSON.parse(JSON.stringify(ledger));
    }
  }

  /**
   * 更新当前分支的文档快照
   */
  public updateDocumentSnapshot(documentId: string, content: string): void {
    const active = this.branches.get(this.activeBranchId);
    if (active) {
      if (!active.documentSnapshots) active.documentSnapshots = {};
      active.documentSnapshots[documentId] = content;
    }
  }

  /**
   * 比对两个平行分支状态账本的差异
   */
  public diffLedgers(baseLedger: StateLedger, targetLedger: StateLedger): LedgerDiffResult {
    const baseEntityMap = new Map<string, StateLedger['entities'][number]>(
      (baseLedger.entities || []).map((c) => [c.id || c.name, c])
    );
    const targetEntityMap = new Map<string, StateLedger['entities'][number]>(
      (targetLedger.entities || []).map((c) => [c.id || c.name, c])
    );

    const addedEntities: string[] = [];
    const changedEntityStatuses: Array<{ name: string; from?: string; to?: string }> = [];

    for (const [id, targetEntity] of targetEntityMap.entries()) {
      const baseEntity = baseEntityMap.get(id);
      if (!baseEntity) {
        addedEntities.push(targetEntity.name || id);
      } else if (baseEntity.status !== targetEntity.status) {
        changedEntityStatuses.push({
          name: targetEntity.name || id,
          from: baseEntity.status,
          to: targetEntity.status
        });
      }
    }

    const baseAssetSet = new Set((baseLedger.assets || []).map((i) => i.id || i.name));
    const addedAssets = (targetLedger.assets || []).filter((i) => !baseAssetSet.has(i.id || i.name)).map((i) => (i.name || i.id || '')).filter(Boolean);

    const baseTracks = new Set((baseLedger.tracks || []).map((f) => f.id || f.clue));
    const newTracks = (targetLedger.tracks || [])
      .filter((f) => !baseTracks.has(f.id || f.clue))
      .map((f) => (f.clue || f.id || '')).filter(Boolean);

    const resolvedTracks = (targetLedger.tracks || [])
      .filter((f) => f.status === 'resolved' && (baseLedger.tracks || []).some((bf) => (bf.id || bf.clue) === (f.id || f.clue) && bf.status === 'pending'))
      .map((f) => (f.clue || f.id || '')).filter(Boolean);

    return {
      addedEntities,
      changedEntityStatuses,
      addedAssets,
      newTracks,
      resolvedTracks
    };
  }

  /**
   * 比对两个分支的文档快照差异
   */
  public diffDocuments(baseBranchId: string, targetBranchId: string): DocumentDiffResult {
    const baseBranch = this.branches.get(baseBranchId);
    const targetBranch = this.branches.get(targetBranchId);
    const baseDocs = baseBranch?.documentSnapshots || {};
    const targetDocs = targetBranch?.documentSnapshots || {};

    const allDocIds = new Set([...Object.keys(baseDocs), ...Object.keys(targetDocs)]);
    const modifiedDocuments: DocumentDiffResult['modifiedDocuments'] = [];

    for (const docId of allDocIds) {
      const baseText = baseDocs[docId] || '';
      const targetText = targetDocs[docId] || '';
      if (baseText !== targetText) {
        const baseLines = baseText.split('\n');
        const targetLines = targetText.split('\n');
        modifiedDocuments.push({
          documentId: docId,
          charsDelta: targetText.length - baseText.length,
          linesAdded: Math.max(0, targetLines.length - baseLines.length),
          linesRemoved: Math.max(0, baseLines.length - targetLines.length)
        });
      }
    }

    return { modifiedDocuments };
  }

  /**
   * 生成平行推演决策报告 (What-If Executive Report)
   */
  public generateExecutiveReport(baseBranchId: string, targetBranchId: string): WhatIfExecutiveReport {
    const baseBranch = this.branches.get(baseBranchId);
    const targetBranch = this.branches.get(targetBranchId);
    if (!baseBranch || !targetBranch) {
      throw new Error(`Invalid branch IDs: ${baseBranchId}, ${targetBranchId}`);
    }

    const ledgerDiff = this.diffLedgers(baseBranch.stateLedger, targetBranch.stateLedger);
    const docDiff = this.diffDocuments(baseBranchId, targetBranchId);

    const summaryParts: string[] = [];
    summaryParts.push(`【平行推演决策报告: ${baseBranch.branchName} VS ${targetBranch.branchName}】`);
    summaryParts.push(`推演前提: ${targetBranch.premise}`);

    if (ledgerDiff.changedEntityStatuses.length > 0) {
      summaryParts.push(`实体状态变动: ${ledgerDiff.changedEntityStatuses.map((c) => `${c.name}(${c.from || '新'} -> ${c.to})`).join(', ')}`);
    }
    if (ledgerDiff.addedEntities.length > 0) {
      summaryParts.push(`新增实体: ${ledgerDiff.addedEntities.join(', ')}`);
    }
    if (ledgerDiff.resolvedTracks.length > 0) {
      summaryParts.push(`闭环线索与状态: ${ledgerDiff.resolvedTracks.join(', ')}`);
    }
    if (docDiff.modifiedDocuments.length > 0) {
      summaryParts.push(`受影响资源: ${docDiff.modifiedDocuments.map((d) => `${d.documentId} (字符Δ: ${d.charsDelta > 0 ? `+${d.charsDelta}` : d.charsDelta})`).join(', ')}`);
    }


    return {
      baseBranchName: baseBranch.branchName,
      targetBranchName: targetBranch.branchName,
      premise: targetBranch.premise,
      ledgerDiff,
      documentDiff: docDiff,
      executiveSummary: summaryParts.join('\n')
    };
  }
}

export const StoryBranchManager = BranchManager;
