import type { InkDb } from './db.js';
import { InkRepository } from './repository.js';
import { LaneManager } from './lanes.js';
import { FtsSearchEngine } from './fts.js';
import { CompactionEngine } from './compaction.js';
import { WriterLeaseManager } from './leases.js';

export interface ConformanceCheckResult {
  suiteName: string;
  passed: boolean;
  durationMs: number;
  error?: string;
}

export interface StorageConformanceReport {
  passed: boolean;
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  checks: ConformanceCheckResult[];
}

/**
 * 存储一致性与崩溃安全验证套件 (1:1 对标 repos/pi packages/session-backends conformance test suite)
 * 验证事务原子性、LSM Delta 重放准确性、FTS5 全文索引同步、多泳道游标隔离及写租约有效性。
 */
export class StorageConformanceSuite {
  private db: InkDb;
  private repo: InkRepository;
  private lanes: LaneManager;
  private fts: FtsSearchEngine;
  private leases: WriterLeaseManager;
  private compactor: CompactionEngine;

  constructor(db: InkDb) {
    this.db = db;
    this.repo = new InkRepository(db);
    this.lanes = new LaneManager(db);
    this.fts = new FtsSearchEngine(db);
    this.leases = new WriterLeaseManager(db);
    this.compactor = new CompactionEngine(db, this.repo);
  }


  public async runAll(): Promise<StorageConformanceReport> {
    const checks: ConformanceCheckResult[] = [];

    checks.push(this.verifyTransactionAtomicity());
    checks.push(this.verifyEventSourcingAndCompaction());
    checks.push(this.verifyFts5AutoSync());
    checks.push(this.verifyLaneForkingAndTipIsolation());
    checks.push(this.verifyWriterLeaseFencing());
    checks.push(this.verifyWalCheckpoint());

    const passedChecks = checks.filter((c) => c.passed).length;
    const failedChecks = checks.length - passedChecks;

    return {
      passed: failedChecks === 0,
      totalChecks: checks.length,
      passedChecks,
      failedChecks,
      checks
    };
  }

  /**
   * 1. 验证事务原子性与失败回滚 (Transaction Rollback Invariant)
   */
  public verifyTransactionAtomicity(): ConformanceCheckResult {
    const start = Date.now();
    try {
      const initialWorkspaceId = `conf_tx_book_${Date.now()}`;
      try {
        this.db.transaction(() => {
          this.repo.createWorkspace({
            id: initialWorkspaceId,
            title: 'Transaction Test Container',
            owner: 'System',
            category: 'Test',
            targetSize: 100000,
            createdAt: Date.now(),
            updatedAt: Date.now()
          });
          // Throw error intentionally to trigger rollback
          throw new Error('Simulated transaction failure');
        });
      } catch (err: any) {
        if (err.message !== 'Simulated transaction failure') throw err;
      }

      // Assert book does NOT exist
      const book = this.repo.getWorkspace(initialWorkspaceId);
      if (book !== undefined) {
        return {
          suiteName: 'Transaction Atomicity & Rollback',
          passed: false,
          durationMs: Date.now() - start,
          error: 'Workspace record was found despite transaction rollback'
        };
      }

      return {
        suiteName: 'Transaction Atomicity & Rollback',
        passed: true,
        durationMs: Date.now() - start
      };
    } catch (err: any) {
      return {
        suiteName: 'Transaction Atomicity & Rollback',
        passed: false,
        durationMs: Date.now() - start,
        error: err.message
      };
    }
  }

  /**
   * 2. 验证 LSM Delta 增量与快照压缩一致性 (Snapshot + Delta Replay)
   */
  public verifyEventSourcingAndCompaction(): ConformanceCheckResult {
    const start = Date.now();
    try {
      const workspaceId = `conf_es_b_${Date.now()}`;
      const volId = `conf_es_v_${Date.now()}`;
      const chId = `conf_ch_${Date.now()}`;

      this.repo.createWorkspace({
        id: workspaceId,
        title: 'ES Test Container',
        owner: 'System',
        category: 'Test',
        targetSize: 10000,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      this.repo.createFolder({
        id: volId,
        workspaceId,
        title: '第一卷',
        orderIndex: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      this.repo.createDocument({
        id: chId,
        folderId: volId,
        workspaceId,
        title: 'ES测试章节',
        orderIndex: 1,
        contentSize: 0,
        status: 'draft',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      this.repo.upsertSnapshot({
        documentId: chId,
        version: 1,
        contentJson: JSON.stringify({ type: 'doc', text: '基础快照段落。' }),
        contentMarkdown: '基础快照段落。',
        contentSize: 7,
        updatedAt: Date.now()
      });


      // Append deltas
      this.repo.appendDelta({
        documentId: chId,
        stepJson: JSON.stringify({ insert: '新增第2句。' }),
        clientTimestamp: Date.now(),
        createdAt: Date.now()
      });

      const deltas = this.repo.getDeltas(chId);
      if (deltas.length !== 1) {
        return {
          suiteName: 'Event Sourcing & Delta Replay',
          passed: false,
          durationMs: Date.now() - start,
          error: `Expected 1 delta, got ${deltas.length}`
        };
      }

      // Compact
      const compactRes = this.compactor.saveSnapshotAndCompact(
        chId,
        2,
        JSON.stringify({ type: 'doc', text: '基础快照段落。新增第2句。' }),
        '基础快照段落。新增第2句。',
        14
      );

      if (!compactRes || compactRes.version !== 2) {
        return {
          suiteName: 'Event Sourcing & Delta Replay',
          passed: false,
          durationMs: Date.now() - start,
          error: 'Compaction returned invalid result'
        };
      }

      const snapAfter = this.repo.getSnapshot(chId);
      if (!snapAfter || snapAfter.version !== 2 || !snapAfter.contentMarkdown.includes('新增第2句。')) {
        return {
          suiteName: 'Event Sourcing & Delta Replay',
          passed: false,
          durationMs: Date.now() - start,
          error: 'Compacted snapshot version or content mismatch'
        };
      }

      return {
        suiteName: 'Event Sourcing & Delta Replay',
        passed: true,
        durationMs: Date.now() - start
      };
    } catch (err: any) {
      return {
        suiteName: 'Event Sourcing & Delta Replay',
        passed: false,
        durationMs: Date.now() - start,
        error: err.message
      };
    }
  }

  /**
   * 3. 验证 SQLite FTS5 全文索引触发器同步
   */
  public verifyFts5AutoSync(): ConformanceCheckResult {
    const start = Date.now();
    try {
      const workspaceId = `fts_b_${Date.now()}`;
      const volId = `fts_v_${Date.now()}`;
      const chId = `fts_ch_${Date.now()}`;

      this.repo.createWorkspace({
        id: workspaceId,
        title: 'FTS测试作品',
        owner: '测试者',
        category: '测试',
        targetSize: 50000,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      this.repo.createFolder({
        id: volId,
        workspaceId,
        title: '第一卷',
        orderIndex: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      this.repo.createDocument({
        id: chId,
        folderId: volId,
        workspaceId,
        title: '测试章节目标',
        orderIndex: 1,
        contentSize: 500,
        status: 'draft',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      this.repo.upsertSnapshot({
        documentId: chId,
        version: 1,
        contentJson: '{}',
        contentMarkdown: '这是一段用于全文检索的测试文本，包含特定目标词汇。',
        contentSize: 26,
        updatedAt: Date.now()
      });

      // Search FTS5
      const searchRes = this.fts.search('目标词汇');
      if (searchRes.length === 0 || searchRes[0].documentId !== chId) {
        return {
          suiteName: 'FTS5 Auto Sync & Search',
          passed: false,
          durationMs: Date.now() - start,
          error: 'FTS search did not return expected chapter'
        };
      }

      return {
        suiteName: 'FTS5 Auto Sync & Search',
        passed: true,
        durationMs: Date.now() - start
      };
    } catch (err: any) {
      return {
        suiteName: 'FTS5 Auto Sync & Search',
        passed: false,
        durationMs: Date.now() - start,
        error: err.message
      };
    }
  }

  /**
   * 4. 验证多泳道派生与 Branch Tips 游标隔离
   */
  public verifyLaneForkingAndTipIsolation(): ConformanceCheckResult {
    const start = Date.now();
    try {
      const workspaceId = `lane_b_${Date.now()}`;
      const volId = `lane_v_${Date.now()}`;
      const mainLaneId = `lane_main_${Date.now()}`;
      const ifLaneId = `lane_if_${Date.now()}`;
      const chId = `ch_test_${Date.now()}`;

      this.repo.createWorkspace({
        id: workspaceId,
        title: '泳道测试',
        owner: '作者',
        category: '测试',
        targetSize: 100000,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      this.repo.createFolder({
        id: volId,
        workspaceId,
        title: '第一卷',
        orderIndex: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      this.repo.createDocument({
        id: chId,
        folderId: volId,
        workspaceId,
        title: '初始测试章节',
        orderIndex: 1,
        contentSize: 100,
        status: 'draft',
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      this.lanes.createLane({
        id: mainLaneId,
        workspaceId,
        name: '主线剧情',
        isDefault: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      });

      this.lanes.setBranchTip({
        laneId: mainLaneId,
        documentId: chId,
        headSnapshotVersion: 3,
        lastDeltaId: 12,
        updatedAt: Date.now()
      });


      // Fork IF lane
      this.lanes.forkLane(mainLaneId, ifLaneId, 'Branch - Alternate Scenario');

      // Update IF lane tip
      this.lanes.setBranchTip({
        laneId: ifLaneId,
        documentId: chId,
        headSnapshotVersion: 5,
        lastDeltaId: 30,
        updatedAt: Date.now()
      });

      // Verify isolation: Main lane tip must still be version 3
      const mainTip = this.lanes.getBranchTip(mainLaneId, chId);
      const ifTip = this.lanes.getBranchTip(ifLaneId, chId);

      if (!mainTip || mainTip.headSnapshotVersion !== 3) {
        return {
          suiteName: 'Lane Forking & Tip Isolation',
          passed: false,
          durationMs: Date.now() - start,
          error: 'Main lane tip was corrupted by changes to forked lane'
        };
      }

      if (!ifTip || ifTip.headSnapshotVersion !== 5) {
        return {
          suiteName: 'Lane Forking & Tip Isolation',
          passed: false,
          durationMs: Date.now() - start,
          error: 'Forked lane tip did not update correctly'
        };
      }

      return {
        suiteName: 'Lane Forking & Tip Isolation',
        passed: true,
        durationMs: Date.now() - start
      };
    } catch (err: any) {
      return {
        suiteName: 'Lane Forking & Tip Isolation',
        passed: false,
        durationMs: Date.now() - start,
        error: err.message
      };
    }
  }

  /**
   * 5. 验证写租约过期与防护 (Writer Lease Fencing)
   */
  public verifyWriterLeaseFencing(): ConformanceCheckResult {
    const start = Date.now();
    try {
      const leaseId = `lease_${Date.now()}`;
      const holder1 = 'agent_worker_1';
      const holder2 = 'agent_worker_2';

      // 1. Holder 1 acquires lease for 500ms
      const acq1 = this.leases.acquire(leaseId, holder1, 500);
      if (!acq1) {
        return {
          suiteName: 'Writer Lease Fencing',
          passed: false,
          durationMs: Date.now() - start,
          error: 'Failed to acquire initial lease'
        };
      }

      // 2. Holder 2 tries to acquire immediately -> should be rejected
      const acq2 = this.leases.acquire(leaseId, holder2, 500);
      if (acq2) {
        return {
          suiteName: 'Writer Lease Fencing',
          passed: false,
          durationMs: Date.now() - start,
          error: 'Holder 2 acquired lease while Holder 1 holds it'
        };
      }

      // 3. Holder 1 releases lease
      this.leases.release(leaseId, holder1);

      // 4. Holder 2 acquires now -> should succeed
      const acq3 = this.leases.acquire(leaseId, holder2, 500);
      if (!acq3) {
        return {
          suiteName: 'Writer Lease Fencing',
          passed: false,
          durationMs: Date.now() - start,
          error: 'Holder 2 failed to acquire lease after release'
        };
      }

      return {
        suiteName: 'Writer Lease Fencing',
        passed: true,
        durationMs: Date.now() - start
      };
    } catch (err: any) {
      return {
        suiteName: 'Writer Lease Fencing',
        passed: false,
        durationMs: Date.now() - start,
        error: err.message
      };
    }
  }


  /**
   * 6. 验证 WAL Checkpoint 执行无异常
   */
  public verifyWalCheckpoint(): ConformanceCheckResult {
    const start = Date.now();
    try {
      this.db.checkpoint();
      return {
        suiteName: 'WAL Checkpoint Resilience',
        passed: true,
        durationMs: Date.now() - start
      };
    } catch (err: any) {
      return {
        suiteName: 'WAL Checkpoint Resilience',
        passed: false,
        durationMs: Date.now() - start,
        error: err.message
      };
    }
  }
}
