import { describe, it, expect } from 'vitest';
import { BranchExplorer } from '../packages/agent-core/src/branch-what-if.js';

describe('What-If Parallel Branching & Document AST Diff Engine (Aligned with Pi)', () => {
  it('should create What-If branch with document snapshots and compare diffs', () => {
    const manager = new BranchExplorer(undefined, {
      mainBranchName: 'Base',
      formatExecutiveReport: ({ baseBranch, targetBranch, ledgerDiff }) => [
        `平行推演决策报告: ${baseBranch.branchName} -> ${targetBranch.branchName}`,
        `${targetBranch.premise}`,
        ...ledgerDiff.changedEntityStatuses.map((change) => `${change.name}(${change.from} -> ${change.to})`),
        ...ledgerDiff.resolvedTracks.map((track) => `闭环线索与状态: ${track}`)
      ].join('\n')
    });

    // 1. Set baseline in mainline
    manager.updateActiveLedger({
      entities: [
        { id: 'c1', name: '林玄', status: '宗门弟子' },
        { id: 'c2', name: '柳青衣', status: '青梅竹马' }
      ],
      assets: [{ id: 'a1', name: '青锋剑', holder: '林玄' }],
      tracks: [{ id: 't1', clue: '身世玉佩之谜', status: 'pending' }],
      locations: [{ name: '青云宗' }],
      modifiedResources: ['ch1']
    });

    manager.updateDocumentSnapshot('ch1', '林玄握紧青锋剑，望向窗外的青云宗后山。');

    // 2. Create parallel branch: "What if 林玄选择反出宗门，投身魔道？"
    const whatIf = manager.createWhatIfBranch(
      'timeline-demon-path',
      '魔道叛门线',
      '假设林玄在第一章拒绝交出玉佩，直接叛出青云宗'
    );

    expect(whatIf.branchId).toBe('timeline-demon-path');

    // Update parallel timeline ledger and document
    whatIf.stateLedger.entities[0]!.status = '魔道巨擘';
    whatIf.stateLedger.tracks[0]!.status = 'resolved';
    if (!whatIf.documentSnapshots) whatIf.documentSnapshots = {};
    whatIf.documentSnapshots['ch1'] = '林玄冷笑一声，折断青锋剑，毅然踏入无尽魔域！';

    // 3. Generate Executive Report
    const report = manager.generateExecutiveReport('main', 'timeline-demon-path');

    expect(report.baseBranchName).toBe('Base');
    expect(report.targetBranchName).toBe('魔道叛门线');
    expect(report.premise).toContain('假设林玄在第一章拒绝交出玉佩');

    // Verify entity status change diff
    expect(report.ledgerDiff.changedEntityStatuses).toEqual([
      { name: '林玄', from: '宗门弟子', to: '魔道巨擘' }
    ]);

    // Verify resolved foreshadowing track
    expect(report.ledgerDiff.resolvedTracks).toContain('身世玉佩之谜');

    // Verify document diff
    expect(report.documentDiff?.modifiedDocuments).toHaveLength(1);
    expect(report.documentDiff?.modifiedDocuments[0]?.documentId).toBe('ch1');

    // Verify summary contains key executive points
    expect(report.executiveSummary).toContain('平行推演决策报告');
    expect(report.executiveSummary).toContain('林玄(宗门弟子 -> 魔道巨擘)');
    expect(report.executiveSummary).toContain('闭环线索与状态: 身世玉佩之谜');
  });
});
