import type { RuntimeState, StateLedger } from '@inkpi/protocol';
import type { Clock, IdGenerator } from './ports/index.js';
import { SessionTree, type SessionTreeNode } from './tree.js';

/**
 * Adapter boundary for state carried by the generic branch explorer.
 *
 * The Runtime owns the branch lifecycle, but it does not know what a state
 * field means. Domain code supplies cloning and comparison behavior here.
 */
export interface StateAdapter<TState extends RuntimeState = RuntimeState, TDiff = unknown> {
  createInitialState(): TState;
  clone(state: TState): TState;
  diff(base: TState, target: TState): TDiff;
}

export interface RuntimeBranchInfo<TState extends RuntimeState = RuntimeState> {
  branchId: string;
  branchName: string;
  description: string;
  forkPointNodeId: string | null;
  currentLeafId: string | null;
  createdAt: number;
  state: TState;
  /** Opaque text resources associated with a branch; keys have no Runtime meaning. */
  snapshots?: Record<string, string>;
}

export interface RuntimeSnapshotDiffResult {
  modifiedResources: Array<{
    resourceId: string;
    charsDelta: number;
    linesAdded: number;
    linesRemoved: number;
  }>;
}

export interface RuntimeBranchReport<TDiff = unknown> {
  baseBranchName: string;
  targetBranchName: string;
  description: string;
  stateDiff: TDiff;
  snapshotDiff?: RuntimeSnapshotDiffResult;
  summary?: string;
}

export interface RuntimeBranchExplorerOptions<TState extends RuntimeState = RuntimeState, TDiff = unknown> {
  stateAdapter: StateAdapter<TState, TDiff>;
  initialState?: TState;
  mainBranchName?: string;
  mainBranchDescription?: string;
  idGenerator?: IdGenerator;
  clock?: Clock;
  formatSwitchSummary?: (input: {
    currentBranch: RuntimeBranchInfo<TState>;
    targetBranch: RuntimeBranchInfo<TState>;
    diff: TDiff;
  }) => string;
  formatReport?: (input: {
    baseBranch: RuntimeBranchInfo<TState>;
    targetBranch: RuntimeBranchInfo<TState>;
    stateDiff: TDiff;
    snapshotDiff: RuntimeSnapshotDiffResult;
  }) => string;
}

/**
 * Generic branch lifecycle for Runtime consumers.
 *
 * This class only stores opaque state and text snapshots. It never extracts,
 * merges, or labels product-domain records; those decisions belong to the
 * injected StateAdapter.
 */
export class RuntimeBranchExplorer<TState extends RuntimeState = RuntimeState, TDiff = unknown> {
  private readonly tree: SessionTree;
  private readonly options: RuntimeBranchExplorerOptions<TState, TDiff>;
  private readonly branches = new Map<string, RuntimeBranchInfo<TState>>();
  private activeBranchId = 'main';
  private readonly idGenerator: IdGenerator;
  private readonly clock: Clock;

  constructor(tree: SessionTree | undefined, options: RuntimeBranchExplorerOptions<TState, TDiff>) {
    this.tree = tree || new SessionTree();
    this.options = options;
    this.clock = options.clock || Date.now;
    this.idGenerator = options.idGenerator || (() => `branch_${this.clock()}`);

    const state = options.initialState
      ? options.stateAdapter.clone(options.initialState)
      : options.stateAdapter.createInitialState();
    this.branches.set('main', {
      branchId: 'main',
      branchName: options.mainBranchName || 'main',
      description: options.mainBranchDescription || '',
      forkPointNodeId: null,
      currentLeafId: this.tree.getCurrentLeafId(),
      createdAt: this.clock(),
      state,
      snapshots: {}
    });
  }

  public getTree(): SessionTree {
    return this.tree;
  }

  public getActiveBranchId(): string {
    return this.activeBranchId;
  }

  public getAllBranches(): RuntimeBranchInfo<TState>[] {
    return Array.from(this.branches.values());
  }

  public getBranch(branchId: string): RuntimeBranchInfo<TState> | undefined {
    return this.branches.get(branchId);
  }

  /** Create a branch from the current tree position and opaque state snapshot. */
  public createBranch(
    branchId: string,
    branchName: string,
    description: string,
    initialState?: TState,
    initialSnapshots?: Record<string, string>
  ): RuntimeBranchInfo<TState> {
    const currentLeaf = this.tree.getCurrentLeafId();
    const activeBranch = this.branches.get(this.activeBranchId);
    const state =
      initialState !== undefined
        ? this.options.stateAdapter.clone(initialState)
        : activeBranch
          ? this.options.stateAdapter.clone(activeBranch.state)
          : this.options.stateAdapter.createInitialState();
    const snapshots = initialSnapshots
      ? { ...initialSnapshots }
      : activeBranch?.snapshots
        ? { ...activeBranch.snapshots }
        : {};

    const branchInfo: RuntimeBranchInfo<TState> = {
      branchId,
      branchName,
      description,
      forkPointNodeId: currentLeaf,
      currentLeafId: currentLeaf,
      createdAt: this.clock(),
      state,
      snapshots
    };
    this.branches.set(branchId, branchInfo);
    return branchInfo;
  }

  public async switchBranch(targetBranchId: string): Promise<{
    switched: boolean;
    branch: RuntimeBranchInfo<TState>;
    summary?: string;
  }> {
    const target = this.branches.get(targetBranchId);
    if (!target) throw new Error(`Branch not found: ${targetBranchId}`);

    const currentBranch = this.branches.get(this.activeBranchId);
    if (currentBranch) {
      currentBranch.currentLeafId = this.tree.getCurrentLeafId() || currentBranch.currentLeafId;
    }

    let summary: string | undefined;
    if (currentBranch && currentBranch.branchId !== targetBranchId) {
      const diff = this.options.stateAdapter.diff(currentBranch.state, target.state);
      summary = this.options.formatSwitchSummary?.({ currentBranch, targetBranch: target, diff });
    }

    this.activeBranchId = targetBranchId;
    if (target.currentLeafId) this.tree.navigate(target.currentLeafId);

    return { switched: true, branch: target, summary };
  }

  public updateActiveState(state: TState): void {
    const active = this.branches.get(this.activeBranchId);
    if (active) active.state = this.options.stateAdapter.clone(state);
  }

  public updateSnapshot(resourceId: string, content: string): void {
    const active = this.branches.get(this.activeBranchId);
    if (!active) return;
    active.snapshots = active.snapshots || {};
    active.snapshots[resourceId] = content;
  }

  public diffState(baseState: TState, targetState: TState): TDiff {
    return this.options.stateAdapter.diff(baseState, targetState);
  }

  public diffSnapshots(baseBranchId: string, targetBranchId: string): RuntimeSnapshotDiffResult {
    const baseBranch = this.branches.get(baseBranchId);
    const targetBranch = this.branches.get(targetBranchId);
    const baseSnapshots = baseBranch?.snapshots || {};
    const targetSnapshots = targetBranch?.snapshots || {};
    const allResourceIds = new Set([...Object.keys(baseSnapshots), ...Object.keys(targetSnapshots)]);
    const modifiedResources: RuntimeSnapshotDiffResult['modifiedResources'] = [];

    for (const resourceId of allResourceIds) {
      const baseText = baseSnapshots[resourceId] || '';
      const targetText = targetSnapshots[resourceId] || '';
      if (baseText === targetText) continue;
      const baseLines = baseText.split('\n');
      const targetLines = targetText.split('\n');
      modifiedResources.push({
        resourceId,
        charsDelta: targetText.length - baseText.length,
        linesAdded: Math.max(0, targetLines.length - baseLines.length),
        linesRemoved: Math.max(0, baseLines.length - targetLines.length)
      });
    }

    return { modifiedResources };
  }

  public generateReport(baseBranchId: string, targetBranchId: string): RuntimeBranchReport<TDiff> {
    const baseBranch = this.branches.get(baseBranchId);
    const targetBranch = this.branches.get(targetBranchId);
    if (!baseBranch || !targetBranch) {
      throw new Error(`Invalid branch IDs: ${baseBranchId}, ${targetBranchId}`);
    }

    const stateDiff = this.options.stateAdapter.diff(baseBranch.state, targetBranch.state);
    const snapshotDiff = this.diffSnapshots(baseBranchId, targetBranchId);
    return {
      baseBranchName: baseBranch.branchName,
      targetBranchName: targetBranch.branchName,
      description: targetBranch.description,
      stateDiff,
      snapshotDiff,
      summary: this.options.formatReport?.({ baseBranch, targetBranch, stateDiff, snapshotDiff })
    };
  }
}

// ---------------------------------------------------------------------------
// Explicit creative compatibility adapter.
// ---------------------------------------------------------------------------

/** @deprecated Use RuntimeBranchExplorer with a domain-owned StateAdapter. */
export interface HypothesisBranchInfo {
  branchId: string;
  branchName: string;
  premise: string;
  forkPointNodeId: string | null;
  currentLeafId: string | null;
  createdAt: number;
  stateLedger: StateLedger;
  documentSnapshots?: Record<string, string>;
}

/** @deprecated Use the diff type defined by the domain-owned StateAdapter. */
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

export interface HypothesisExecutiveReport {
  baseBranchName: string;
  targetBranchName: string;
  premise: string;
  ledgerDiff: LedgerDiffResult;
  documentDiff?: DocumentDiffResult;
  executiveSummary?: string;
}

export interface BranchExplorerOptions {
  mainBranchName?: string;
  mainBranchPremise?: string;
  idGenerator?: IdGenerator;
  clock?: Clock;
  formatSwitchSummary?: (input: {
    currentBranch: HypothesisBranchInfo;
    targetBranch: HypothesisBranchInfo;
    diff: LedgerDiffResult;
  }) => string;
  formatExecutiveReport?: (input: {
    baseBranch: HypothesisBranchInfo;
    targetBranch: HypothesisBranchInfo;
    ledgerDiff: LedgerDiffResult;
    documentDiff: DocumentDiffResult;
  }) => string;
}

type CreativeStateAdapter = StateAdapter<StateLedger, LedgerDiffResult>;

const creativeStateAdapter: CreativeStateAdapter = {
  createInitialState: createEmptyStateLedger,
  clone: cloneStateLedger,
  diff: diffStateLedger
};

function createEmptyStateLedger(): StateLedger {
  return { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] };
}

function cloneStateLedger(state: StateLedger): StateLedger {
  return structuredClone(state);
}

/**
 * Domain-owned StateAdapter implementation kept solely for the legacy
 * creative API. RuntimeBranchExplorer never calls this function directly.
 */
function diffStateLedger(baseLedger: StateLedger, targetLedger: StateLedger): LedgerDiffResult {
  const baseEntityMap = new Map<string, StateLedger['entities'][number]>(
    (baseLedger.entities || []).map((entity) => [entity.id || entity.name, entity])
  );
  const targetEntityMap = new Map<string, StateLedger['entities'][number]>(
    (targetLedger.entities || []).map((entity) => [entity.id || entity.name, entity])
  );

  const addedEntities: string[] = [];
  const changedEntityStatuses: LedgerDiffResult['changedEntityStatuses'] = [];
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

  const baseAssetSet = new Set((baseLedger.assets || []).map((asset) => asset.id || asset.name));
  const addedAssets = (targetLedger.assets || [])
    .filter((asset) => !baseAssetSet.has(asset.id || asset.name))
    .map((asset) => asset.name || asset.id || '')
    .filter(Boolean);

  const baseTracks = new Set((baseLedger.tracks || []).map((track) => track.id || track.clue));
  const newTracks = (targetLedger.tracks || [])
    .filter((track) => !baseTracks.has(track.id || track.clue))
    .map((track) => track.clue || track.id || '')
    .filter(Boolean);

  const resolvedTracks = (targetLedger.tracks || [])
    .filter(
      (track) =>
        track.status === 'resolved' &&
        (baseLedger.tracks || []).some(
          (baseTrack) => (baseTrack.id || baseTrack.clue) === (track.id || track.clue) && baseTrack.status === 'pending'
        )
    )
    .map((track) => track.clue || track.id || '')
    .filter(Boolean);

  return { addedEntities, changedEntityStatuses, addedAssets, newTracks, resolvedTracks };
}

function toHypothesisBranch(branch: RuntimeBranchInfo<StateLedger>): HypothesisBranchInfo {
  return {
    branchId: branch.branchId,
    branchName: branch.branchName,
    premise: branch.description,
    forkPointNodeId: branch.forkPointNodeId,
    currentLeafId: branch.currentLeafId,
    createdAt: branch.createdAt,
    stateLedger: branch.state,
    documentSnapshots: branch.snapshots
  };
}

function toDocumentDiff(diff: RuntimeSnapshotDiffResult): DocumentDiffResult {
  return {
    modifiedDocuments: diff.modifiedResources.map((resource) => ({
      documentId: resource.resourceId,
      charsDelta: resource.charsDelta,
      linesAdded: resource.linesAdded,
      linesRemoved: resource.linesRemoved
    }))
  };
}

/**
 * Legacy creative branch facade. It is an adapter around RuntimeBranchExplorer;
 * all StateLedger/entity/asset/track/document vocabulary is confined to this
 * compatibility layer.
 */
export class BranchExplorer {
  private readonly runtime: RuntimeBranchExplorer<StateLedger, LedgerDiffResult>;

  constructor(tree?: SessionTree, options: BranchExplorerOptions = {}) {
    this.runtime = new RuntimeBranchExplorer<StateLedger, LedgerDiffResult>(tree, {
      stateAdapter: creativeStateAdapter,
      mainBranchName: options.mainBranchName,
      mainBranchDescription: options.mainBranchPremise,
      idGenerator: options.idGenerator,
      clock: options.clock,
      formatSwitchSummary: options.formatSwitchSummary
        ? ({ currentBranch, targetBranch, diff }) =>
            options.formatSwitchSummary!({
              currentBranch: toHypothesisBranch(currentBranch),
              targetBranch: toHypothesisBranch(targetBranch),
              diff
            })
        : undefined,
      formatReport: options.formatExecutiveReport
        ? ({ baseBranch, targetBranch, stateDiff, snapshotDiff }) =>
            options.formatExecutiveReport!({
              baseBranch: toHypothesisBranch(baseBranch),
              targetBranch: toHypothesisBranch(targetBranch),
              ledgerDiff: stateDiff,
              documentDiff: toDocumentDiff(snapshotDiff)
            })
        : undefined
    });
  }

  public getTree(): SessionTree {
    return this.runtime.getTree();
  }

  public getActiveBranchId(): string {
    return this.runtime.getActiveBranchId();
  }

  public getAllBranches(): HypothesisBranchInfo[] {
    return this.runtime.getAllBranches().map(toHypothesisBranch);
  }

  public getBranch(branchId: string): HypothesisBranchInfo | undefined {
    const branch = this.runtime.getBranch(branchId);
    return branch ? toHypothesisBranch(branch) : undefined;
  }

  public createWhatIfBranch(
    branchId: string,
    branchName: string,
    premise: string,
    initialLedger?: StateLedger,
    initialDocuments?: Record<string, string>
  ): HypothesisBranchInfo {
    return toHypothesisBranch(
      this.runtime.createBranch(branchId, branchName, premise, initialLedger, initialDocuments)
    );
  }

  public async switchBranch(targetBranchId: string): Promise<{
    switched: boolean;
    branch: HypothesisBranchInfo;
    summary?: string;
  }> {
    const result = await this.runtime.switchBranch(targetBranchId);
    return { ...result, branch: toHypothesisBranch(result.branch) };
  }

  public updateActiveLedger(ledger: StateLedger): void {
    this.runtime.updateActiveState(ledger);
  }

  public updateDocumentSnapshot(documentId: string, content: string): void {
    this.runtime.updateSnapshot(documentId, content);
  }

  public diffLedgers(baseLedger: StateLedger, targetLedger: StateLedger): LedgerDiffResult {
    return this.runtime.diffState(baseLedger, targetLedger);
  }

  public diffDocuments(baseBranchId: string, targetBranchId: string): DocumentDiffResult {
    return toDocumentDiff(this.runtime.diffSnapshots(baseBranchId, targetBranchId));
  }

  public generateExecutiveReport(baseBranchId: string, targetBranchId: string): HypothesisExecutiveReport {
    const report = this.runtime.generateReport(baseBranchId, targetBranchId);
    return {
      baseBranchName: report.baseBranchName,
      targetBranchName: report.targetBranchName,
      premise: report.description,
      ledgerDiff: report.stateDiff,
      documentDiff: report.snapshotDiff ? toDocumentDiff(report.snapshotDiff) : undefined,
      executiveSummary: report.summary
    };
  }
}
