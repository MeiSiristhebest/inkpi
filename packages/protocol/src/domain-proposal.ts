/**
 * A reviewable domain mutation produced by an AI task.
 *
 * The runtime transports and validates proposals, but never applies the
 * patch to authoritative desktop state. The caller-supplied commit adapter is
 * responsible for the atomic revision check and IndexedDB write.
 */
export interface DomainProposalEvidence {
  documentId?: string;
  blockId?: string;
  excerpt?: string;
  semanticFrom?: number;
  semanticTo?: number;
}

export type DomainProposalOperation = 'create' | 'update' | 'delete';

export interface DomainProposal {
  id: string;
  taskId: string;
  baseRevision: number;
  sourceHash?: string;
  target: {
    type: string;
    id: string;
  };
  operation: DomainProposalOperation;
  patch?: unknown;
  evidence?: DomainProposalEvidence[];
  reason?: string;
}

export type DomainProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale' | 'committed' | 'undone';

export interface DomainProposalCommitReceipt {
  proposalId: string;
  target: DomainProposal['target'];
  operation: DomainProposalOperation;
  patch?: unknown;
  inversePatch?: unknown;
  revision: number;
}

export function validateDomainProposal(proposal: DomainProposal): void {
  if (!proposal.id.trim() || !proposal.taskId.trim()) {
    throw new Error('Domain proposal identifiers must not be empty');
  }
  if (!Number.isInteger(proposal.baseRevision) || proposal.baseRevision < 0) {
    throw new Error('Domain proposal base revision must be a non-negative integer');
  }
  if (!proposal.target?.type?.trim() || !proposal.target?.id?.trim()) {
    throw new Error('Domain proposal target must identify a domain object');
  }
  if (proposal.operation !== 'delete' && proposal.patch === undefined) {
    throw new Error('Create and update proposals require a patch');
  }
  if (proposal.evidence && !Array.isArray(proposal.evidence)) {
    throw new Error('Domain proposal evidence must be an array');
  }
}
