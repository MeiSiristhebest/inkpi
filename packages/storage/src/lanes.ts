import type { InkDb } from './db.js';

export interface Lane {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  parentLaneId?: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BranchTip {
  laneId: string;
  documentId: string;
  headSnapshotVersion: number;
  lastDeltaId: number;
  baseSnapshotVersion?: number;
  baseDeltaId?: number;
  updatedAt: number;
}

/**
 * Durable lane and branch-tip storage.
 *
 * Fork metadata and the original tip are persisted so merges can reject
 * concurrent target changes instead of silently overwriting them.
 */
export class LaneManager {
  private db: InkDb;

  constructor(db: InkDb) {
    this.db = db;
  }

  public createLane(lane: Lane): void {
    this.db.transaction(() => {
      if (lane.isDefault) {
        // Clear previous default
        const clearStmt = this.db.prepare('UPDATE lanes SET is_default = 0 WHERE workspace_id = ?');
        clearStmt.run(lane.workspaceId);
      }

      const stmt = this.db.prepare(`
        INSERT INTO lanes (id, workspace_id, name, description, parent_lane_id, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        lane.id,
        lane.workspaceId,
        lane.name,
        lane.description || null,
        lane.parentLaneId || null,
        lane.isDefault ? 1 : 0,
        lane.createdAt,
        lane.updatedAt
      );
    });
  }

  public getLane(id: string): Lane | undefined {
    const stmt = this.db.prepare('SELECT * FROM lanes WHERE id = ?');
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description || undefined,
      parentLaneId: row.parent_lane_id || undefined,
      isDefault: Boolean(row.is_default),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  public getLanes(workspaceId: string): Lane[] {
    const stmt = this.db.prepare('SELECT * FROM lanes WHERE workspace_id = ? ORDER BY is_default DESC, created_at ASC');
    const rows = stmt.all(workspaceId) as any[];
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      description: r.description || undefined,
      parentLaneId: r.parent_lane_id || undefined,
      isDefault: Boolean(r.is_default),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    }));
  }

  public setDefaultLane(workspaceId: string, laneId: string): void {
    this.db.transaction(() => {
      const lane = this.getLane(laneId);
      if (!lane || lane.workspaceId !== workspaceId) {
        throw new Error(`Lane '${laneId}' not found in workspace '${workspaceId}'`);
      }
      this.db.prepare('UPDATE lanes SET is_default = 0 WHERE workspace_id = ?').run(workspaceId);
      this.db.prepare('UPDATE lanes SET is_default = 1 WHERE id = ?').run(laneId);
    });
  }

  public setBranchTip(tip: BranchTip): void {
    const lane = this.getLane(tip.laneId);
    if (!lane) throw new Error(`Lane '${tip.laneId}' not found`);

    const document = this.db
      .prepare(`
      SELECT id, workspace_id AS workspaceId
      FROM documents
      WHERE id = ?
    `)
      .get(tip.documentId) as { id: string; workspaceId: string } | undefined;
    if (!document) throw new Error(`Document '${tip.documentId}' not found`);
    if (document.workspaceId !== lane.workspaceId) {
      throw new Error(`Document '${tip.documentId}' does not belong to lane workspace '${lane.workspaceId}'`);
    }

    const stmt = this.db.prepare(`
      INSERT INTO branch_tips (
        lane_id, document_id, head_snapshot_version, last_delta_id,
        base_snapshot_version, base_delta_id, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(lane_id, document_id) DO UPDATE SET
        head_snapshot_version = excluded.head_snapshot_version,
        last_delta_id = excluded.last_delta_id,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      tip.laneId,
      tip.documentId,
      tip.headSnapshotVersion,
      tip.lastDeltaId,
      tip.baseSnapshotVersion ?? tip.headSnapshotVersion,
      tip.baseDeltaId ?? tip.lastDeltaId,
      tip.updatedAt
    );
  }

  public getBranchTip(laneId: string, documentId: string): BranchTip | undefined {
    const stmt = this.db.prepare('SELECT * FROM branch_tips WHERE lane_id = ? AND document_id = ?');
    const row = stmt.get(laneId, documentId) as any;
    if (!row) return undefined;
    return {
      laneId: row.lane_id,
      documentId: row.document_id,
      headSnapshotVersion: Number(row.head_snapshot_version),
      lastDeltaId: Number(row.last_delta_id),
      baseSnapshotVersion: Number(row.base_snapshot_version ?? row.head_snapshot_version),
      baseDeltaId: Number(row.base_delta_id ?? row.last_delta_id),
      updatedAt: Number(row.updated_at)
    };
  }

  public getBranchTips(laneId: string): BranchTip[] {
    const stmt = this.db.prepare('SELECT * FROM branch_tips WHERE lane_id = ?');
    const rows = stmt.all(laneId) as any[];
    return rows.map((r) => ({
      laneId: r.lane_id,
      documentId: r.document_id,
      headSnapshotVersion: Number(r.head_snapshot_version),
      lastDeltaId: Number(r.last_delta_id),
      baseSnapshotVersion: Number(r.base_snapshot_version ?? r.head_snapshot_version),
      baseDeltaId: Number(r.base_delta_id ?? r.last_delta_id),
      updatedAt: Number(r.updated_at)
    }));
  }

  /**
   * 从指定源泳道派生 (Fork) 出新的平行分支泳道，并克隆所有最新游标
   */
  public forkLane(sourceLaneId: string, targetLaneId: string, targetName: string, description?: string): Lane {
    const sourceLane = this.getLane(sourceLaneId);
    if (!sourceLane) throw new Error(`Source lane '${sourceLaneId}' not found`);
    if (sourceLaneId === targetLaneId) {
      throw new Error('Source and target lane IDs must differ');
    }
    if (this.getLane(targetLaneId)) {
      throw new Error(`Target lane '${targetLaneId}' already exists`);
    }

    const now = Date.now();
    const newLane: Lane = {
      id: targetLaneId,
      workspaceId: sourceLane.workspaceId,
      name: targetName,
      description: description || `Forked from ${sourceLane.name}`,
      parentLaneId: sourceLaneId,
      isDefault: false,
      createdAt: now,
      updatedAt: now
    };

    this.db.transaction(() => {
      this.createLane(newLane);
      const sourceTips = this.getBranchTips(sourceLaneId);
      for (const tip of sourceTips) {
        this.setBranchTip({
          laneId: targetLaneId,
          documentId: tip.documentId,
          headSnapshotVersion: tip.headSnapshotVersion,
          lastDeltaId: tip.lastDeltaId,
          baseSnapshotVersion: tip.headSnapshotVersion,
          baseDeltaId: tip.lastDeltaId,
          updatedAt: now
        });
      }
    });

    return newLane;
  }

  /**
   * Fast-forward a forked lane into its parent lane.
   *
   * The target must still equal the tip recorded at fork time. This is a
   * compare-and-set check: concurrent target edits are reported as conflicts.
   */
  public mergeLane(sourceLaneId: string, targetLaneId: string): { mergedCount: number } {
    const sourceLane = this.getLane(sourceLaneId);
    const targetLane = this.getLane(targetLaneId);
    if (!sourceLane) throw new Error(`Source lane '${sourceLaneId}' not found`);
    if (!targetLane) throw new Error(`Target lane '${targetLaneId}' not found`);
    if (sourceLaneId === targetLaneId) {
      throw new Error('Source and target lane IDs must differ');
    }
    if (sourceLane.workspaceId !== targetLane.workspaceId) {
      throw new Error('Source and target lanes must belong to the same workspace');
    }
    if (sourceLane.parentLaneId !== targetLaneId) {
      throw new Error(
        `Lane '${sourceLaneId}' can only fast-forward into its parent lane '${sourceLane.parentLaneId || '(none)'}'`
      );
    }

    const sourceTips = this.getBranchTips(sourceLaneId);
    let mergedCount = 0;

    this.db.transaction(() => {
      const now = Date.now();
      for (const tip of sourceTips) {
        const targetTip = this.getBranchTip(targetLaneId, tip.documentId);
        if (!targetTip) {
          throw new Error(`Lane merge conflict for document '${tip.documentId}': target has no fork baseline`);
        }
        const expectedSnapshot = targetTip.baseSnapshotVersion ?? targetTip.headSnapshotVersion;
        const expectedDelta = targetTip.baseDeltaId ?? targetTip.lastDeltaId;
        if (targetTip.headSnapshotVersion !== expectedSnapshot || targetTip.lastDeltaId !== expectedDelta) {
          throw new Error(`Lane merge conflict for document '${tip.documentId}': target changed after fork`);
        }
        this.setBranchTip({
          laneId: targetLaneId,
          documentId: tip.documentId,
          headSnapshotVersion: tip.headSnapshotVersion,
          lastDeltaId: tip.lastDeltaId,
          baseSnapshotVersion: targetTip.baseSnapshotVersion,
          baseDeltaId: targetTip.baseDeltaId,
          updatedAt: now
        });
        mergedCount++;
      }
    });

    return { mergedCount };
  }
}
