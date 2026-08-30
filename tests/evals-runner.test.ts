import { describe, it, expect } from 'vitest';
import {
  EntityConsistencyScorer,
  ForeshadowingPayoffScorer,
  TypographyComplianceScorer,
  EvalRunner
} from '@inkpi/evals';

describe('Evaluation Benchmark Suite (@inkpi/evals)', () => {
  it('should score entity consistency and detect status contradictions', () => {
    const scorer = new EntityConsistencyScorer();
    
    // Normal text without contradictions
    const res1 = scorer.score('UserB 完成了系统初始化。', {
      entities: [{ name: 'UserB', status: 'Injured' }],
      assets: [],
      tracks: [],
      locations: [],
      modifiedDocuments: []
    });
    expect(res1.passed).toBe(true);
    expect(res1.score).toBe(100);

    // Contradictory text (injured entity jumping around with zero damage)
    const res2 = scorer.score('UserB 纵身跃起，生龙活虎地施展全力狂奔。', {
      entities: [{ name: 'UserB', status: 'Injured' }],
      assets: [],
      tracks: [],
      locations: [],
      modifiedDocuments: []
    });
    expect(res2.score).toBeLessThan(100);
    expect(res2.violations.length).toBeGreaterThan(0);
  });

  it('should score foreshadowing payoff rates', () => {
    const scorer = new ForeshadowingPayoffScorer();

    const ledger = {
      entities: [],
      assets: [],
      tracks: [
        { clue: 'system architecture review', status: 'resolved' as const },
        { clue: 'legacy api migration', status: 'pending' as const }
      ],
      locations: [],
      modifiedDocuments: []
    };

    const res = scorer.score(ledger);
    expect(res.totalClues).toBe(2);
    expect(res.resolvedClues).toBe(1);
    expect(res.pendingClues).toBe(1);
    expect(res.payoffRatePercent).toBe(50);
    expect(res.passed).toBe(true);
  });

  it('should score Chinese typography compliance', () => {
    const scorer = new TypographyComplianceScorer();

    // Standard Chinese formatted text
    const goodText = '　　“系统自检启动！”UserB进程初始化成功。……\n　　In the night, the wind blew.';
    const goodRes = scorer.score(goodText);
    expect(goodRes.passed).toBe(true);
    expect(goodRes.score).toBeGreaterThanOrEqual(85);

    // Badly formatted text with ASCII quotes and dots
    const badText = '"System check!"UserB冷声道...四周杀机四伏.';
    const badRes = scorer.score(badText);
    expect(badRes.score).toBeLessThan(80);
    expect(badRes.violationsCount).toBeGreaterThan(0);
  });

  it('should run EvalRunner and generate comprehensive benchmark report', () => {
    const runner = new EvalRunner();

    const report = runner.evaluateDocument({
      title: 'Workspace Title',
      documentTitle: '第十document 最终集成测试',
      content: '　　“执行开始！”UserA系统引导序列启动……\n　　所有服务运行正常。Capital City。',
      stateLedger: {
        entities: [{ name: 'UserA', status: 'State Level 99' }],
        assets: [{ name: 'Test Asset A' }],
        tracks: [{ clue: 'Test Clue 1', status: 'resolved' }],
        locations: [],
        modifiedDocuments: []
      },
      targetSize: 35
    });

    expect(report.overallScore).toBeGreaterThan(70);
    expect(['S', 'A', 'S', 'C']).toContain(report.grade);
    expect(report.scores.characterConsistency.passed).toBe(true);
    expect(report.scores.typographyCompliance.score).toBeGreaterThan(80);
    expect(report.summary).toContain('Evaluation Score');
  });

  it('should test edge cases and all grade levels in EvalRunner', () => {
    const runner = new EvalRunner();
    const consistencyScorer = new EntityConsistencyScorer();
    const foreshadowingScorer = new ForeshadowingPayoffScorer();
    const typographyScorer = new TypographyComplianceScorer();

    // 1. Empty state ledger & invariants test
    const emptyRes = consistencyScorer.score('Normal Text', {
      entities: [],
      assets: [],
      tracks: [],
      locations: [],
      modifiedDocuments: []
    });
    expect(emptyRes.score).toBe(100);

    const invRes = consistencyScorer.score('UserCbetrays guild and joins faction Z。', {
      entities: [{ name: 'UserC' }],
      assets: [],
      tracks: [],
      locations: [],
      modifiedDocuments: []
    }, [
      { entity: 'UserC', forbiddenTransitions: ['joins faction Z'] }
    ]);
    expect(invRes.violations.length).toBe(1);

    // 2. Track empty & penalty branches
    const emptyClues = foreshadowingScorer.score({
      entities: [],
      assets: [],
      tracks: [],
      locations: [],
      modifiedDocuments: []
    });
    expect(emptyClues.score).toBe(100);

    const heavyPending = foreshadowingScorer.score({
      entities: [],
      assets: [],
      tracks: [
        { clue: 'Task1', status: 'pending' },
        { clue: 'Task2', status: 'pending' },
        { clue: 'Task3', status: 'pending' },
        { clue: 'Task4', status: 'pending' },
        { clue: 'Task5', status: 'pending' },
        { clue: 'Task6', status: 'pending' }
      ],
      locations: [],
      modifiedDocuments: []
    }, '正文并无解开Task，但提到真相大白');
    expect(heavyPending.score).toBeLessThanOrEqual(60);

    // 3. Typography half-width checks
    const puncRes = typographyScorer.score('mixed,english;wrong..indent');
    expect(puncRes.metrics.halfWidthPunctuationCount).toBeGreaterThan(0);
    expect(puncRes.metrics.invalidEllipsisCount).toBeGreaterThan(0);

    // 5. Grade S/A
    const reportS = runner.evaluateDocument({
      title: 'Perfect Result',
      documentTitle: 'Perfect Document',
      content: '　　“系统组件运行正常。”UserA正在等待指令……\n　　微风拂过，远山如黛。',
      stateLedger: {
        entities: [{ name: 'UserA', status: 'Peak State' }],
        assets: [],
        tracks: [{ clue: 'Ancient Secret', status: 'resolved' }],
        locations: [],
        modifiedDocuments: []
      },
      targetSize: 24
    });
    expect(reportS.overallScore).toBeGreaterThanOrEqual(80);

    // 6. Grade A/B
    const reportA = runner.evaluateDocument({
      title: 'Good Result',
      documentTitle: 'Good Document',
      content: '　　“系统上线。”UserA就绪。',
      stateLedger: {
        entities: [{ name: 'UserA', status: 'Peak State' }],
        assets: [],
        tracks: [{ clue: 'Ancient Secret', status: 'resolved' }],
        locations: [],
        modifiedDocuments: []
      },
      targetSize: 100
    });
    expect(reportA.overallScore).toBeGreaterThanOrEqual(60);

    // 7. Grade B/C
    const reportB = runner.evaluateDocument({
      title: 'Medium Result',
      documentTitle: 'Document B',
      content: '"half-width quotes!"UserArunning... logs streaming.。',
      stateLedger: {
        entities: [{ name: 'UserA', status: 'Normal State' }],
        assets: [],
        tracks: [
          { clue: 'TaskA', status: 'pending' },
          { clue: 'TaskB', status: 'pending' },
          { clue: 'TaskC', status: 'pending' },
          { clue: 'TaskD', status: 'pending' },
          { clue: 'TaskE', status: 'pending' }
        ],
        locations: [],
        modifiedDocuments: []
      },
      targetSize: 10
    });
    expect(reportB.overallScore).toBeDefined();



    // 8. Grade C (60 - 74)
    const reportC = runner.evaluateDocument({
      title: 'Pass Result',
      documentTitle: 'Document C',
      content: '"half-width quotes!"UserArunning... logs streaming..',
      stateLedger: {
        entities: [{ name: 'UserA', status: 'Normal State' }],
        assets: [],
        tracks: [
          { clue: 'TaskA', status: 'pending' },
          { clue: 'TaskB', status: 'pending' },
          { clue: 'TaskC', status: 'pending' },
          { clue: 'TaskD', status: 'pending' },
          { clue: 'TaskE', status: 'pending' },
          { clue: 'TaskF', status: 'pending' }
        ],
        locations: [],
        modifiedDocuments: []
      },
      targetSize: 100
    });
    expect(reportC.overallScore).toBeGreaterThan(0);

    // 9. Grade F (< 60)
    const reportF = runner.evaluateDocument({
      title: '不Pass Result',
      documentTitle: 'Document F',
      content: '"half-width quotes!"UserAUserB started the background process without errors....四周狂风,黑夜漫漫.',
      stateLedger: {
        entities: [{ name: 'UserA', status: 'Injured' }],
        assets: [],
        tracks: [
          { clue: 'TaskA', status: 'pending' },
          { clue: 'TaskB', status: 'pending' },
          { clue: 'TaskC', status: 'pending' },
          { clue: 'TaskD', status: 'pending' },
          { clue: 'TaskE', status: 'pending' },
          { clue: 'TaskF', status: 'pending' }
        ],
        locations: [],
        modifiedDocuments: []
      },
      targetSize: 1000
    });
    expect(reportF.grade).toBe('F');

    // 10. Test Empty content & targetSize fallback
    const reportEmpty = runner.evaluateDocument({
      title: 'Empty Content',
      documentTitle: 'Empty Document',
      content: '',
      stateLedger: {
        entities: [],
        assets: [],
        tracks: [],
        locations: [],
        modifiedDocuments: []
      }
    });
    expect(reportEmpty.overallScore).toBeDefined();

    // 11. Test zero targetSize
    const reportZeroTarget = runner.evaluateDocument({
      title: 'Zero Target Words',
      documentTitle: 'Zero Document',
      content: '　　“Has content。”……\n　　测试。',
      stateLedger: {
        entities: [],
        assets: [],
        tracks: [],
        locations: [],
        modifiedDocuments: []
      },
      targetSize: 0
    });
    expect(reportZeroTarget.overallScore).toBeDefined();

    // 12. evaluateChapter alias and sectionTitle / chapterTitle fallbacks
    const reportChapter = runner.evaluateChapter({
      title: 'Chapter Test',
      chapterTitle: 'Chapter 1',
      content: 'Text content here',
      stateLedger: {
        entities: [],
        assets: [],
        tracks: [],
        locations: [],
        modifiedDocuments: []
      }
    });
    expect(reportChapter.chapterTitle).toBe('Chapter 1');

    const reportSection = runner.evaluateDocument({
      title: 'Section Test',
      sectionTitle: 'Section A',
      content: 'Text content here',
      stateLedger: {
        entities: [],
        assets: [],
        tracks: [],
        locations: [],
        modifiedDocuments: []
      }
    });
    expect(reportSection.chapterTitle).toBe('Section A');

    // Invariant condition and requiredKeywords testing
    const invConditionRes = consistencyScorer.score('UserD is waiting quietly.', {
      entities: [{ name: 'UserD', status: 'Idle' }],
      assets: [],
      tracks: [],
      locations: [],
      modifiedDocuments: []
    }, [
      {
        character: 'UserD',
        condition: (_text, status) => status === 'Active',
        requiredKeywords: ['ActiveSignal']
      }
    ]);
    expect(invConditionRes.violations.length).toBe(2);
    expect(invConditionRes.passed).toBe(false);
  });
});




