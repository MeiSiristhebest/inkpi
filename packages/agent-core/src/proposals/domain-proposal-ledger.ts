import {
  type DomainProposal,
  type DomainProposalCommitReceipt,
  type DomainProposalStatus,
  validateDomainProposal
} from '@inkpi/protocol';

export interface DomainProposalRecord extends DomainProposal {
  status: DomainProposalStatus;
  createdAt: number;
  updatedAt: number;
  committedRevision?: number;
  inversePatch?: unknown;
}

export interface DomainProposalCommitResult {
  inversePatch?: unknown;
}

// biome-ignore lint/suspicious/noConfusingVoidType: commit callbacks may intentionally return no inverse patch.
type ApplyResult = DomainProposalCommitResult | void;

/**
 * Adapter for an authoritative domain store. Its commit/undo operations must
 * enforce the expected revision atomically; the Runtime only supplies the
 * proposal and never writes domain facts itself.
 */
export interface DomainProposalCommitAdapter {
  commit(input: {
    proposal: DomainProposalRecord;
    expectedRevision: number;
    expectedSourceHash?: string;
    nextRevision: number;
  }): DomainProposalCommitResult | Promise<DomainProposalCommitResult>;
  undo(input: {
    proposal: DomainProposalRecord;
    patch: unknown;
    expectedRevision: number;
    nextRevision: number;
  }): void | Promise<void>;
}

export class ProposalConflictError extends Error {
  readonly code = 'PROPOSAL_CONFLICT';

  constructor(
    readonly proposalId: string,
    readonly expectedRevision: number,
    readonly actualRevision: number
  ) {
    super(`Proposal ${proposalId} is stale: expected revision ${expectedRevision}, received ${actualRevision}`);
    this.name = 'ProposalConflictError';
  }
}

/** Review ledger for domain-neutral proposals. It has no domain-state dependency. */
export class DomainProposalLedger {
  private readonly proposals = new Map<string, DomainProposalRecord>();
  private readonly committing = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  create(proposal: DomainProposal, createdAt = this.now()): DomainProposalRecord {
    validateDomainProposal(proposal);
    if (this.proposals.has(proposal.id)) throw new Error(`Proposal already exists: ${proposal.id}`);
    const stored: DomainProposalRecord = {
      ...cloneValue(proposal),
      status: 'pending',
      createdAt,
      updatedAt: createdAt
    };
    this.proposals.set(stored.id, stored);
    return cloneValue(stored);
  }

  get(proposalId: string): DomainProposalRecord | undefined {
    const proposal = this.proposals.get(proposalId);
    return proposal ? cloneValue(proposal) : undefined;
  }

  list(target?: DomainProposal['target']): DomainProposalRecord[] {
    return [...this.proposals.values()]
      .filter((proposal) => !target || (proposal.target.type === target.type && proposal.target.id === target.id))
      .map(cloneValue);
  }

  accept(proposalId: string): DomainProposalRecord {
    const proposal = this.require(proposalId);
    if (proposal.status !== 'pending') throw new Error(`Proposal ${proposalId} is not pending`);
    proposal.status = 'accepted';
    proposal.updatedAt = this.now();
    return cloneValue(proposal);
  }

  reject(proposalId: string): DomainProposalRecord {
    const proposal = this.require(proposalId);
    if (proposal.status !== 'pending') throw new Error(`Proposal ${proposalId} is not pending`);
    proposal.status = 'rejected';
    proposal.updatedAt = this.now();
    return cloneValue(proposal);
  }

  modify(
    proposalId: string,
    change: { patch?: unknown; reason?: string; baseRevision?: number; sourceHash?: string }
  ): DomainProposalRecord {
    const proposal = this.require(proposalId);
    if (proposal.status === 'committed' || proposal.status === 'undone') {
      throw new Error(`Proposal ${proposalId} cannot be modified after ${proposal.status}`);
    }
    if (change.patch !== undefined) proposal.patch = cloneValue(change.patch);
    if (change.reason !== undefined) proposal.reason = change.reason;
    if (change.sourceHash !== undefined) proposal.sourceHash = change.sourceHash;
    if (change.baseRevision !== undefined) {
      if (!Number.isInteger(change.baseRevision) || change.baseRevision < 0) {
        throw new Error('Domain proposal base revision must be a non-negative integer');
      }
      proposal.baseRevision = change.baseRevision;
    }
    validateDomainProposal(proposal);
    proposal.status = 'pending';
    proposal.updatedAt = this.now();
    return cloneValue(proposal);
  }

  rebase(
    proposalId: string,
    currentRevision: number,
    transform: (patch: unknown) => unknown = (patch) => patch,
    currentSourceHash?: string
  ): DomainProposalRecord {
    const proposal = this.require(proposalId);
    if (!['pending', 'accepted', 'stale'].includes(proposal.status)) {
      throw new Error(`Proposal ${proposalId} cannot be rebased from ${proposal.status}`);
    }
    if (!Number.isInteger(currentRevision) || currentRevision < 0) {
      throw new Error('Invalid rebase revision');
    }
    proposal.patch = cloneValue(transform(cloneValue(proposal.patch)));
    proposal.baseRevision = currentRevision;
    proposal.sourceHash = currentSourceHash;
    validateDomainProposal(proposal);
    proposal.status = 'pending';
    proposal.updatedAt = this.now();
    return cloneValue(proposal);
  }

  async commit(
    proposalId: string,
    currentRevision: number,
    apply: (patch: unknown, nextRevision: number) => ApplyResult | Promise<ApplyResult>,
    currentSourceHash?: string
  ): Promise<DomainProposalCommitReceipt> {
    const proposal = this.requireAccepted(proposalId);
    this.assertCurrent(proposal, currentRevision, currentSourceHash);
    if (this.committing.has(proposalId)) throw new Error(`Proposal ${proposalId} is already being committed`);
    const nextRevision = currentRevision + 1;
    this.committing.add(proposalId);
    let result: ApplyResult;
    try {
      result = await apply(cloneValue(proposal.patch), nextRevision);
    } catch (error) {
      if (error instanceof ProposalConflictError) proposal.status = 'stale';
      proposal.updatedAt = this.now();
      throw error;
    } finally {
      this.committing.delete(proposalId);
    }
    proposal.inversePatch = cloneValue(inversePatchOf(result));
    proposal.committedRevision = nextRevision;
    proposal.status = 'committed';
    proposal.updatedAt = this.now();
    return receipt(proposal, nextRevision, proposal.patch, proposal.inversePatch);
  }

  async commitWithAdapter(
    proposalId: string,
    adapter: DomainProposalCommitAdapter,
    currentRevision: number,
    currentSourceHash?: string
  ): Promise<DomainProposalCommitReceipt> {
    return this.commit(
      proposalId,
      currentRevision,
      (patch, nextRevision) =>
        adapter.commit({
          proposal: this.requireAccepted(proposalId),
          expectedRevision: currentRevision,
          expectedSourceHash: currentSourceHash,
          nextRevision
        }),
      currentSourceHash
    );
  }

  async undo(
    proposalId: string,
    currentRevision: number,
    apply: (patch: unknown, nextRevision: number) => void | Promise<void>
  ): Promise<DomainProposalCommitReceipt> {
    const proposal = this.require(proposalId);
    if (proposal.status !== 'committed') throw new Error(`Proposal ${proposalId} is not committed`);
    if (proposal.inversePatch === undefined) throw new Error(`Proposal ${proposalId} has no inverse patch`);
    const committedRevision = proposal.committedRevision ?? currentRevision;
    if (currentRevision !== committedRevision) {
      proposal.status = 'stale';
      proposal.updatedAt = this.now();
      throw new ProposalConflictError(proposal.id, committedRevision, currentRevision);
    }
    const nextRevision = currentRevision + 1;
    try {
      await apply(cloneValue(proposal.inversePatch), nextRevision);
    } catch (error) {
      if (error instanceof ProposalConflictError) proposal.status = 'stale';
      proposal.updatedAt = this.now();
      throw error;
    }
    proposal.status = 'undone';
    proposal.updatedAt = this.now();
    return receipt(proposal, nextRevision, proposal.inversePatch);
  }

  async undoWithAdapter(
    proposalId: string,
    adapter: DomainProposalCommitAdapter,
    currentRevision: number
  ): Promise<DomainProposalCommitReceipt> {
    return this.undo(proposalId, currentRevision, (patch, nextRevision) =>
      adapter.undo({
        proposal: this.require(proposalId),
        patch,
        expectedRevision: currentRevision,
        nextRevision
      })
    );
  }

  private require(proposalId: string): DomainProposalRecord {
    const proposal = this.proposals.get(proposalId);
    if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
    return proposal;
  }

  private requireAccepted(proposalId: string): DomainProposalRecord {
    const proposal = this.require(proposalId);
    if (proposal.status !== 'accepted') throw new Error(`Proposal ${proposalId} must be accepted before commit`);
    return proposal;
  }

  private assertCurrent(proposal: DomainProposalRecord, revision: number, sourceHash?: string): void {
    if (!Number.isInteger(revision) || revision < 0) throw new Error('Invalid current revision');
    if (revision !== proposal.baseRevision) {
      proposal.status = 'stale';
      proposal.updatedAt = this.now();
      throw new ProposalConflictError(proposal.id, proposal.baseRevision, revision);
    }
    if (sourceHash !== undefined && proposal.sourceHash !== undefined && sourceHash !== proposal.sourceHash) {
      proposal.status = 'stale';
      proposal.updatedAt = this.now();
      throw new Error(`Proposal ${proposal.id} source hash does not match the current document`);
    }
  }
}

function receipt(
  proposal: DomainProposalRecord,
  revision: number,
  patch: unknown,
  inversePatch?: unknown
): DomainProposalCommitReceipt {
  return {
    proposalId: proposal.id,
    target: cloneValue(proposal.target),
    operation: proposal.operation,
    patch: cloneValue(patch),
    inversePatch: cloneValue(inversePatch),
    revision
  };
}

function inversePatchOf(result: ApplyResult): unknown {
  return result?.inversePatch;
}

function cloneValue<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== 'object') return value;
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}
