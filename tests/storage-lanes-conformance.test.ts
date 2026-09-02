import { describe, it, expect } from 'vitest';
import { InkDb, LaneManager } from '@inkpi/storage';
import { StorageConformanceSuite } from './storage-conformance-suite.js';

describe('Storage Layer - Lanes, Branch Tips & Conformance Suite', () => {
  it('should manage lanes and branch tips accurately', () => {
    const db = new InkDb(':memory:');
    const lanes = new LaneManager(db);

    const workspaceId = 'workspace_lanes_1';
    db.prepare(`
      INSERT INTO workspaces (id, title, owner, category, target_size, created_at, updated_at)
      VALUES (?, '测试workspace', 'owner者', '科幻', 50000, 1000, 1000)
    `).run(workspaceId);

    db.prepare(`
      INSERT INTO folders (id, workspace_id, title, order_index, created_at, updated_at)
      VALUES ('vol_1', ?, '第一folder', 1, 1000, 1000)
    `).run(workspaceId);

    db.prepare(`
      INSERT INTO documents (id, folder_id, workspace_id, title, order_index, content_size, created_at, updated_at)
      VALUES ('ch_101', 'vol_1', ?, '第一document', 1, 0, 1000, 1000)
    `).run(workspaceId);

    // Create Main lane
    lanes.createLane({
      id: 'lane_main',
      workspaceId,
      name: 'Main Line',
      isDefault: true,
      createdAt: 1000,
      updatedAt: 1000
    });

    // Set branch tip
    lanes.setBranchTip({
      laneId: 'lane_main',
      documentId: 'ch_101',
      headSnapshotVersion: 2,
      lastDeltaId: 5,
      updatedAt: 1000
    });


    const tip = lanes.getBranchTip('lane_main', 'ch_101');
    expect(tip).toBeDefined();
    expect(tip?.headSnapshotVersion).toBe(2);

    // Fork IF lane
    const forked = lanes.forkLane('lane_main', 'lane_if_1', 'Branch: Save NPC');
    expect(forked.id).toBe('lane_if_1');

    const ifTips = lanes.getBranchTips('lane_if_1');
    expect(ifTips.length).toBe(1);
    expect(ifTips[0].documentId).toBe('ch_101');

    // Merge lane
    const mergeRes = lanes.mergeLane('lane_if_1', 'lane_main');
    expect(mergeRes.mergedCount).toBe(1);

    // Test getLane, setDefaultLane and edge cases
    expect(lanes.getLane('non_existent')).toBeUndefined();
    expect(lanes.getBranchTip('lane_main', 'non_existent_ch')).toBeUndefined();

    lanes.setDefaultLane(workspaceId, 'lane_if_1');
    const updatedIfLane = lanes.getLane('lane_if_1');
    expect(updatedIfLane?.isDefault).toBe(true);
    expect(() => lanes.setDefaultLane(workspaceId, 'missing_lane')).toThrow('not found');
    expect(() => lanes.setBranchTip({
      laneId: 'missing_lane',
      documentId: 'ch_101',
      headSnapshotVersion: 1,
      lastDeltaId: 0,
      updatedAt: 1000
    })).toThrow('not found');
    expect(() => lanes.forkLane('lane_main', 'lane_if_1', 'Duplicate')).toThrow('already exists');
    expect(() => lanes.mergeLane('lane_main', 'lane_main')).toThrow('must differ');
    expect(lanes.getLanes('empty_workspace')).toEqual([]);
    expect(lanes.getBranchTips('empty_lane')).toEqual([]);

    expect(() => lanes.forkLane('non_existent', 'target', 'Target')).toThrow();
    expect(() => lanes.mergeLane('non_existent', 'lane_main')).toThrow('Source lane');

    db.close();
  });

  it('should reject a merge when the parent lane changed after fork', () => {
    const db = new InkDb(':memory:');
    const lanes = new LaneManager(db);
    const workspaceId = 'workspace_lane_conflict';

    db.prepare(`
      INSERT INTO workspaces (id, title, owner, created_at, updated_at)
      VALUES (?, 'Workspace', 'owner', 1000, 1000)
    `).run(workspaceId);
    db.prepare(`
      INSERT INTO folders (id, workspace_id, title, order_index, created_at, updated_at)
      VALUES ('folder', ?, 'Folder', 1, 1000, 1000)
    `).run(workspaceId);
    db.prepare(`
      INSERT INTO documents (id, folder_id, workspace_id, title, order_index, content_size, created_at, updated_at)
      VALUES ('document', 'folder', ?, 'Document', 1, 0, 1000, 1000)
    `).run(workspaceId);

    lanes.createLane({
      id: 'parent',
      workspaceId,
      name: 'Parent',
      isDefault: true,
      createdAt: 1000,
      updatedAt: 1000
    });
    lanes.setBranchTip({
      laneId: 'parent',
      documentId: 'document',
      headSnapshotVersion: 1,
      lastDeltaId: 1,
      updatedAt: 1000
    });
    lanes.forkLane('parent', 'child', 'Child');

    lanes.setBranchTip({
      laneId: 'child',
      documentId: 'document',
      headSnapshotVersion: 2,
      lastDeltaId: 2,
      updatedAt: 1001
    });
    lanes.setBranchTip({
      laneId: 'parent',
      documentId: 'document',
      headSnapshotVersion: 3,
      lastDeltaId: 3,
      updatedAt: 1002
    });

    expect(() => lanes.mergeLane('child', 'parent')).toThrow('target changed after fork');
    expect(lanes.getBranchTip('parent', 'document')).toMatchObject({
      headSnapshotVersion: 3,
      lastDeltaId: 3
    });
    db.close();
  });

  it('should only fast-forward a lane into its recorded parent', () => {
    const db = new InkDb(':memory:');
    const lanes = new LaneManager(db);
    const workspaceId = 'workspace_lane_parent';
    db.prepare(`
      INSERT INTO workspaces (id, title, owner, created_at, updated_at)
      VALUES (?, 'Workspace', 'owner', 1000, 1000)
    `).run(workspaceId);

    lanes.createLane({
      id: 'lane_a',
      workspaceId,
      name: 'A',
      isDefault: true,
      createdAt: 1000,
      updatedAt: 1000
    });
    lanes.createLane({
      id: 'lane_b',
      workspaceId,
      name: 'B',
      isDefault: false,
      createdAt: 1000,
      updatedAt: 1000
    });
    lanes.createLane({
      id: 'lane_child',
      workspaceId,
      name: 'Child',
      parentLaneId: 'lane_a',
      isDefault: false,
      createdAt: 1000,
      updatedAt: 1000
    });

    expect(() => lanes.mergeLane('lane_child', 'lane_b')).toThrow('parent lane');

    // getLanes test
    const allLanes = lanes.getLanes(workspaceId);
    expect(allLanes[0]?.id).toBe('lane_a');
    expect(allLanes[0]?.isDefault).toBe(true);
    expect(lanes.getLanes('empty_ws')).toEqual([]);

    // Cross-workspace merge rejection
    db.prepare(`
      INSERT INTO workspaces (id, title, owner, created_at, updated_at)
      VALUES ('other_workspace_id', 'Other WS', 'owner', 1000, 1000)
    `).run();

    lanes.createLane({
      id: 'lane_other_ws',
      workspaceId: 'other_workspace_id',
      name: 'Other WS Lane',
      isDefault: true,
      createdAt: 1000,
      updatedAt: 1000
    });
    expect(() => lanes.mergeLane('lane_child', 'lane_other_ws')).toThrow('same workspace');

    db.close();
  });



  it('should run full storage conformance suite and pass 100% checks', async () => {
    const db = new InkDb(':memory:');
    const suite = new StorageConformanceSuite(db);

    const report = await suite.runAll();
    if (!report.passed) {
      console.log('Failed checks:', report.checks.filter(c => !c.passed));
    }
    expect(report.passed).toBe(true);
    expect(report.failedChecks).toBe(0);

    expect(report.totalChecks).toBe(6);
    expect(report.passedChecks).toBe(6);

    for (const check of report.checks) {
      expect(check.passed).toBe(true);
      expect(check.durationMs).toBeGreaterThanOrEqual(0);
    }

    db.close();

    // Test error branches when database is closed
    const brokenSuite = new StorageConformanceSuite(db);
    expect(brokenSuite.verifyTransactionAtomicity().passed).toBe(false);
    expect(brokenSuite.verifyEventSourcingAndCompaction().passed).toBe(false);
    expect(brokenSuite.verifyFts5AutoSync().passed).toBe(false);
    expect(brokenSuite.verifyLaneForkingAndTipIsolation().passed).toBe(false);
    expect(brokenSuite.verifyWriterLeaseFencing().passed).toBe(false);
    // A closed database cannot checkpoint; the previously-swallowed error must now surface.
    expect(brokenSuite.verifyWalCheckpoint().passed).toBe(false);
  });
});


