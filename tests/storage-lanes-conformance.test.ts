import { describe, it, expect } from 'vitest';
import { InkDb, LaneManager, StorageConformanceSuite } from '@inkpi/storage';

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
    expect(lanes.getLanes('empty_workspace')).toEqual([]);
    expect(lanes.getBranchTips('empty_lane')).toEqual([]);

    expect(() => lanes.forkLane('non_existent', 'target', 'Target')).toThrow();

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
    expect(brokenSuite.verifyWalCheckpoint().passed).toBe(true);
  });
});


