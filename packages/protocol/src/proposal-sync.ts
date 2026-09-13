import { type DomainProposal, type DomainProposalStatus, validateDomainProposal } from './domain-proposal.js';

/**
 * Runtime-side projection of a reviewable proposal.
 *
 * The daemon stores this as a derived read model. `patch` and `inversePatch`
 * remain opaque so the Runtime does not depend on a creative-domain model.
 */
export interface ProposalProjectionState extends DomainProposal {
  status: DomainProposalStatus;
  createdAt: number;
  updatedAt: number;
  committedRevision?: number;
  inversePatch?: unknown;
}

export interface ProposalSyncPushParams {
  workspaceId: string;
  expectedRevision: number;
  proposal: ProposalProjectionState;
  stateHash: string;
}

export interface ProposalSyncSnapshotParams {
  workspaceId: string;
}

export interface ProposalSyncPushResult {
  accepted: boolean;
  duplicate: boolean;
  workspaceId: string;
  proposalId: string;
  revision: number;
  stateHash: string;
  reason?: 'revision-conflict' | 'hash-mismatch' | 'invalid-proposal';
  currentHash?: string;
}

export interface ProposalProjectionSnapshot {
  workspaceId: string;
  revision: number;
  proposals: ProposalProjectionState[];
  hash: string;
  updatedAt: number;
}

export function validateProposalProjectionState(state: ProposalProjectionState): void {
  validateDomainProposal(state);
  if (!isProposalStatus(state.status)) throw new Error('Proposal projection has an invalid status');
  if (!isNonNegativeInteger(state.createdAt) || !isNonNegativeInteger(state.updatedAt)) {
    throw new Error('Proposal projection timestamps must be non-negative integers');
  }
  if (state.committedRevision !== undefined && !isNonNegativeInteger(state.committedRevision)) {
    throw new Error('Proposal projection committed revision must be a non-negative integer');
  }
}

/** Hashes the canonical wire state, excluding no fields. */
export function calculateProposalProjectionStateHash(state: ProposalProjectionState): string {
  return fnv1a(stableSerialize(state));
}

/** Hashes the canonical, id-sorted snapshot contents. */
export function calculateProposalProjectionSnapshotHash(
  input: Pick<ProposalProjectionSnapshot, 'workspaceId' | 'revision' | 'proposals'>
): string {
  return fnv1a(
    stableSerialize({
      workspaceId: input.workspaceId,
      revision: input.revision,
      proposals: [...input.proposals].sort((left, right) => left.id.localeCompare(right.id))
    })
  );
}

function isProposalStatus(value: unknown): value is DomainProposalStatus {
  return (
    value === 'pending' ||
    value === 'accepted' ||
    value === 'rejected' ||
    value === 'stale' ||
    value === 'committed' ||
    value === 'undone'
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** JSON-compatible canonical serialization with deterministic object keys. */
function stableSerialize(value: unknown): string {
  if (value === undefined || value === null) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}
