import {
  calculateProposalProjectionSnapshotHash,
  calculateProposalProjectionStateHash,
  type ProposalProjectionSnapshot,
  type ProposalProjectionState,
  type ProposalSyncPushParams,
  type ProposalSyncPushResult,
  validateProposalProjectionState,
} from '@inkpi/protocol';
import type { IDb } from './ports.js';

export interface ProposalProjectionCursor {
  revision: number;
  snapshotHash: string;
  updatedAt: number;
}

interface ProposalProjectionRow {
  workspace_id: string;
  proposal_id: string;
  revision: number;
  state_hash: string;
  state_json: string;
  updated_at: number;
}

/**
 * SQLite read model for Desktop proposal review state.
 *
 * IndexedDB remains authoritative. This store only accepts a complete,
 * hash-verified state snapshot and advances a per-workspace projection cursor
 * with an optimistic CAS check.
 */
export class ProposalProjectionStore {
  public constructor(
    private readonly db: IDb,
    private readonly now: () => number = Date.now,
  ) {}

  public apply(params: ProposalSyncPushParams): ProposalSyncPushResult {
    validatePushParams(params);
    validateProposalProjectionState(params.proposal);
    const calculatedHash = calculateProposalProjectionStateHash(params.proposal);

    return this.db.transaction(() => {
      const current = this.getCursor(params.workspaceId);
      const existing = this.getRow(params.workspaceId, params.proposal.id);

      if (params.stateHash !== calculatedHash) {
        return {
          accepted: false,
          duplicate: false,
          workspaceId: params.workspaceId,
          proposalId: params.proposal.id,
          revision: current.revision,
          stateHash: calculatedHash,
          reason: 'hash-mismatch',
          currentHash: current.snapshotHash,
        };
      }

      // A retry of an already persisted state is idempotent even if another
      // proposal has advanced the workspace cursor since the original write.
      if (existing && existing.state_hash === calculatedHash) {
        parseRow(existing);
        return {
          accepted: true,
          duplicate: true,
          workspaceId: params.workspaceId,
          proposalId: params.proposal.id,
          revision: Number(existing.revision),
          stateHash: calculatedHash,
        };
      }

      if (params.expectedRevision !== current.revision) {
        return {
          accepted: false,
          duplicate: false,
          workspaceId: params.workspaceId,
          proposalId: params.proposal.id,
          revision: current.revision,
          stateHash: calculatedHash,
          reason: 'revision-conflict',
          currentHash: current.snapshotHash,
        };
      }

      const revision = current.revision + 1;
      const updatedAt = this.now();
      this.db
        .prepare(
          `INSERT INTO proposal_projections
            (workspace_id, proposal_id, revision, state_hash, state_json, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(workspace_id, proposal_id) DO UPDATE SET
             revision = excluded.revision,
             state_hash = excluded.state_hash,
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
        )
        .run(
          params.workspaceId,
          params.proposal.id,
          revision,
          calculatedHash,
          JSON.stringify(params.proposal),
          updatedAt,
        );

      const proposals = this.readProposals(params.workspaceId);
      const snapshotHash = calculateProposalProjectionSnapshotHash({
        workspaceId: params.workspaceId,
        revision,
        proposals,
      });
      this.db
        .prepare(
          `INSERT INTO proposal_projection_cursors
            (workspace_id, revision, snapshot_hash, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(workspace_id) DO UPDATE SET
             revision = excluded.revision,
             snapshot_hash = excluded.snapshot_hash,
             updated_at = excluded.updated_at`,
        )
        .run(params.workspaceId, revision, snapshotHash, updatedAt);

      return {
        accepted: true,
        duplicate: false,
        workspaceId: params.workspaceId,
        proposalId: params.proposal.id,
        revision,
        stateHash: calculatedHash,
      };
    });
  }

  public getCursor(workspaceId: string): ProposalProjectionCursor {
    assertWorkspaceId(workspaceId);
    const row = this.db
      .prepare(
        `SELECT revision, snapshot_hash, updated_at
         FROM proposal_projection_cursors WHERE workspace_id = ?`,
      )
      .get(workspaceId) as
      | { revision: number; snapshot_hash: string; updated_at: number }
      | undefined;
    if (!row) {
      return {
        revision: 0,
        snapshotHash: calculateProposalProjectionSnapshotHash({
          workspaceId,
          revision: 0,
          proposals: [],
        }),
        updatedAt: 0,
      };
    }
    return {
      revision: Number(row.revision),
      snapshotHash: String(row.snapshot_hash),
      updatedAt: Number(row.updated_at),
    };
  }

  public snapshot(workspaceId: string): ProposalProjectionSnapshot {
    const cursor = this.getCursor(workspaceId);
    const proposals = this.readProposals(workspaceId);
    const hash = calculateProposalProjectionSnapshotHash({
      workspaceId,
      revision: cursor.revision,
      proposals,
    });
    if (hash !== cursor.snapshotHash) {
      throw new Error(`Proposal projection snapshot hash mismatch for workspace: ${workspaceId}`);
    }
    return {
      workspaceId,
      revision: cursor.revision,
      proposals,
      hash,
      updatedAt: cursor.updatedAt,
    };
  }

  private getRow(workspaceId: string, proposalId: string): ProposalProjectionRow | undefined {
    return this.db
      .prepare(
        `SELECT workspace_id, proposal_id, revision, state_hash, state_json, updated_at
         FROM proposal_projections
         WHERE workspace_id = ? AND proposal_id = ?`,
      )
      .get(workspaceId, proposalId) as ProposalProjectionRow | undefined;
  }

  private readProposals(workspaceId: string): ProposalProjectionState[] {
    const rows = this.db
      .prepare(
        `SELECT workspace_id, proposal_id, revision, state_hash, state_json, updated_at
         FROM proposal_projections
         WHERE workspace_id = ? ORDER BY proposal_id ASC`,
      )
      .all(workspaceId) as ProposalProjectionRow[];
    return rows.map((row) => parseRow(row));
  }
}

function validatePushParams(params: ProposalSyncPushParams): void {
  assertWorkspaceId(params.workspaceId);
  if (!Number.isSafeInteger(params.expectedRevision) || params.expectedRevision < 0) {
    throw new Error('Proposal sync expected revision must be a non-negative integer');
  }
  if (typeof params.stateHash !== 'string' || params.stateHash.trim().length === 0) {
    throw new Error('Proposal sync state hash must be a non-empty string');
  }
}

function parseRow(row: ProposalProjectionRow): ProposalProjectionState {
  const proposal = JSON.parse(row.state_json) as ProposalProjectionState;
  validateProposalProjectionState(proposal);
  const calculatedHash = calculateProposalProjectionStateHash(proposal);
  if (calculatedHash !== row.state_hash) {
    throw new Error(`Proposal projection state hash mismatch: ${row.proposal_id}`);
  }
  if (proposal.id !== row.proposal_id) {
    throw new Error(`Proposal projection id mismatch: ${row.proposal_id}`);
  }
  return proposal;
}

function assertWorkspaceId(workspaceId: string): void {
  if (typeof workspaceId !== 'string' || workspaceId.trim().length === 0) {
    throw new Error('Proposal sync workspace id must be a non-empty string');
  }
}
