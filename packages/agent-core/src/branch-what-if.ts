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
}

export interface LedgerDiffResult {
  addedEntities: string[];
  changedEntityStatuses: Array<{ name: string; from?: string; to?: string }>;
  addedAssets: string[];
  newTracks: string[];
  resolvedTracks: string[];
}

/**
 * 通用多线推演管理器 (1:1 落地 repos/pi SessionTree & Branch Summarization 架构)
 * 允许在任意节点开辟平行时间线，进行 What-If 假设推演、自动对比状态账本差异。
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
      }
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
    initialLedger?: StateLedger
  ): WhatIfBranchInfo {
    const currentLeaf = this.tree.getCurrentLeafId() || 'root';
    const activeBranch = this.branches.get(this.activeBranchId);

    const ledger: StateLedger = initialLedger
      ? { ...initialLedger }
      : activeBranch
      ? JSON.parse(JSON.stringify(activeBranch.stateLedger))
      : { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] };

    const branchInfo: WhatIfBranchInfo = {
      branchId,
      branchName,
      premise,
      forkPointNodeId: currentLeaf,
      currentLeafId: currentLeaf,
      createdAt: Date.now(),
      stateLedger: ledger
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
}

export const StoryBranchManager = BranchManager;
