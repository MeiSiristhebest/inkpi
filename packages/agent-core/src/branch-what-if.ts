import type { StateLedger } from '@inkpi/protocol';
import { SessionTree, type SessionTreeNode } from './tree.js';
import type { Clock, IdGenerator } from './ports/index.js';

export interface WhatIfBranchInfo {
  branchId: string;
  branchName: string;
  premise: string;
  forkPointNodeId: string | null;
  currentLeafId: string | null;
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
  executiveSummary?: string;
}

export interface BranchManagerOptions {
  mainBranchName?: string;
  mainBranchPremise?: string;
  idGenerator?: IdGenerator;
  clock?: Clock;
  formatSwitchSummary?: (input: {
    currentBranch: WhatIfBranchInfo;
    targetBranch: WhatIfBranchInfo;
    diff: LedgerDiffResult;
  }) => string;
  formatExecutiveReport?: (input: {
    baseBranch: WhatIfBranchInfo;
    targetBranch: WhatIfBranchInfo;
    ledgerDiff: LedgerDiffResult;
    documentDiff: DocumentDiffResult;
  }) => string;
}

/**
 * Generic branch manager built on SessionTree and explicit state/document
 * projections. It can compare arbitrary branch scenarios without assuming a
 * content domain.
 */
export class BranchManager {
  private tree: SessionTree;
  private options: BranchManagerOptions;
  private branches = new Map<string, WhatIfBranchInfo>();
  private activeBranchId = 'main';
  private idGenerator: IdGenerator;
  private clock: Clock;

  constructor(tree?: SessionTree, options: BranchManagerOptions = {}) {
    this.tree = tree || new SessionTree();
    this.options = options;
    this.idGenerator = options.idGenerator || (() => `branch_${this.clock()}`);
    this.clock = options.clock || Date.now;

    // 默认主线分支
    this.branches.set('main', {
      branchId: 'main',
      branchName: options.mainBranchName || 'main',
      premise: options.mainBranchPremise || '',
      forkPointNodeId: null,
      currentLeafId: this.tree.getCurrentLeafId(),
      createdAt: this.clock(),
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
   * Create a branch scenario from the current tree position.
   */
  public createWhatIfBranch(
    branchId: string,
    branchName: string,
    premise: string,
    initialLedger?: StateLedger,
    initialDocuments?: Record<string, string>
  ): WhatIfBranchInfo {
    const currentLeaf = this.tree.getCurrentLeafId();
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
      createdAt: this.clock(),
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
      summaryText = this.options.formatSwitchSummary?.({
        currentBranch,
        targetBranch: target,
        diff
      });
    }

    this.activeBranchId = targetBranchId;
    if (target.currentLeafId) {
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
   * Generate a branch comparison report.
   */
  public generateExecutiveReport(baseBranchId: string, targetBranchId: string): WhatIfExecutiveReport {
    const baseBranch = this.branches.get(baseBranchId);
    const targetBranch = this.branches.get(targetBranchId);
    if (!baseBranch || !targetBranch) {
      throw new Error(`Invalid branch IDs: ${baseBranchId}, ${targetBranchId}`);
    }

    const ledgerDiff = this.diffLedgers(baseBranch.stateLedger, targetBranch.stateLedger);
    const docDiff = this.diffDocuments(baseBranchId, targetBranchId);

    return {
      baseBranchName: baseBranch.branchName,
      targetBranchName: targetBranch.branchName,
      premise: targetBranch.premise,
      ledgerDiff,
      documentDiff: docDiff,
      executiveSummary: this.options.formatExecutiveReport?.({
        baseBranch,
        targetBranch,
        ledgerDiff,
        documentDiff: docDiff
      })
    };
  }
}

export const StoryBranchManager = BranchManager;
