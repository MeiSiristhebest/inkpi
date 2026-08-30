import type { InkDb } from './db.js';

export interface Lane {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface BranchTip {
  laneId: string;
  documentId: string;
  headSnapshotVersion: number;
  lastDeltaId: number;
  updatedAt: number;
}

/**
 * 小说多泳道与分支游标追踪器 (1:1 对标 repos/pi packages/session-backends lanes & branch-tips)
 * 支持同一部小说在「主线剧情」、「IF线/支线」、「草案推演」等多个并行分支间自由切换与合并。
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
        const clearStmt = this.db.prepare(`UPDATE lanes SET is_default = 0 WHERE workspace_id = ?`);
        clearStmt.run(lane.workspaceId);
      }

      const stmt = this.db.prepare(`
        INSERT INTO lanes (id, workspace_id, name, description, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        lane.id,
        lane.workspaceId,
        lane.name,
        lane.description || null,
        lane.isDefault ? 1 : 0,
        lane.createdAt,
        lane.updatedAt
      );
    });
  }

  public getLane(id: string): Lane | undefined {
    const stmt = this.db.prepare(`SELECT * FROM lanes WHERE id = ?`);
    const row = stmt.get(id) as any;
    if (!row) return undefined;
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description || undefined,
      isDefault: Boolean(row.is_default),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at)
    };
  }

  public getLanes(workspaceId: string): Lane[] {
    const stmt = this.db.prepare(`SELECT * FROM lanes WHERE workspace_id = ? ORDER BY is_default DESC, created_at ASC`);
    const rows = stmt.all(workspaceId) as any[];
    return rows.map((r) => ({
      id: r.id,
      workspaceId: r.workspace_id,
      name: r.name,
      description: r.description || undefined,
      isDefault: Boolean(r.is_default),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at)
    }));
  }

  public setDefaultLane(workspaceId: string, laneId: string): void {
    this.db.transaction(() => {
      this.db.prepare(`UPDATE lanes SET is_default = 0 WHERE workspace_id = ?`).run(workspaceId);
      this.db.prepare(`UPDATE lanes SET is_default = 1 WHERE id = ? AND workspace_id = ?`).run(laneId, workspaceId);
    });
  }

  public setBranchTip(tip: BranchTip): void {
    const stmt = this.db.prepare(`
      INSERT INTO branch_tips (lane_id, document_id, head_snapshot_version, last_delta_id, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(lane_id, document_id) DO UPDATE SET
        head_snapshot_version = excluded.head_snapshot_version,
        last_delta_id = excluded.last_delta_id,
        updated_at = excluded.updated_at
    `);
    stmt.run(tip.laneId, tip.documentId, tip.headSnapshotVersion, tip.lastDeltaId, tip.updatedAt);
  }

  public getBranchTip(laneId: string, documentId: string): BranchTip | undefined {
    const stmt = this.db.prepare(`SELECT * FROM branch_tips WHERE lane_id = ? AND document_id = ?`);
    const row = stmt.get(laneId, documentId) as any;
    if (!row) return undefined;
    return {
      laneId: row.lane_id,
      documentId: row.document_id,
      headSnapshotVersion: Number(row.head_snapshot_version),
      lastDeltaId: Number(row.last_delta_id),
      updatedAt: Number(row.updated_at)
    };
  }

  public getBranchTips(laneId: string): BranchTip[] {
    const stmt = this.db.prepare(`SELECT * FROM branch_tips WHERE lane_id = ?`);
    const rows = stmt.all(laneId) as any[];
    return rows.map((r) => ({
      laneId: r.lane_id,
      documentId: r.document_id,
      headSnapshotVersion: Number(r.head_snapshot_version),
      lastDeltaId: Number(r.last_delta_id),
      updatedAt: Number(r.updated_at)
    }));
  }

  /**
   * 从指定源泳道派生 (Fork) 出新的平行剧情泳道，并克隆所有最新章节游标
   */
  public forkLane(sourceLaneId: string, targetLaneId: string, targetName: string, description?: string): Lane {
    const sourceLane = this.getLane(sourceLaneId);
    if (!sourceLane) throw new Error(`Source lane '${sourceLaneId}' not found`);

    const now = Date.now();
    const newLane: Lane = {
      id: targetLaneId,
      workspaceId: sourceLane.workspaceId,
      name: targetName,
      description: description || `Forked from ${sourceLane.name}`,
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
          updatedAt: now
        });
      }
    });

    return newLane;
  }

  /**
   * 将分支泳道合并回目标泳道 (Fast-forward tips merge)
   */
  public mergeLane(sourceLaneId: string, targetLaneId: string): { mergedCount: number } {
    const sourceTips = this.getBranchTips(sourceLaneId);
    let mergedCount = 0;

    this.db.transaction(() => {
      const now = Date.now();
      for (const tip of sourceTips) {
        this.setBranchTip({
          laneId: targetLaneId,
          documentId: tip.documentId,
          headSnapshotVersion: tip.headSnapshotVersion,
          lastDeltaId: tip.lastDeltaId,
          updatedAt: now
        });
        mergedCount++;
      }
    });

    return { mergedCount };
  }
}
