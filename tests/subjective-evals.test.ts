import { readFileSync } from 'node:fs';
import {
  type LongContextEvaluationInput,
  type SubjectiveGoldSet,
  type SubjectivePairwiseSet,
  type SubjectiveRubric,
  evaluateLongContextBenchmark,
  evaluateSubjectiveGoldSet,
  evaluateSubjectivePairwise,
  evaluateSubjectiveRubric
} from '@inkpi/evals';
import { describe, expect, it } from 'vitest';

function readFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(`../packages/evals/fixtures/${relativePath}`, import.meta.url), 'utf8')) as T;
}

describe('Phase 18 subjective eval fixtures', () => {
  it('evaluates hook, style, voice, and rewrite gold contracts', () => {
    const fixture = readFixture<SubjectiveGoldSet>('subjective/gold-set.json');
    const report = evaluateSubjectiveGoldSet(fixture);

    expect(report.passed).toBe(true);
    expect(report.score).toBe(91);
    expect(report.metrics).toMatchObject({
      caseCount: 4,
      passedCaseCount: 4,
      failedCaseCount: 0,
      passRatePercent: 100,
      averageScore: 91,
      threshold: 85
    });
    expect(report.cases.map((subjectiveCase) => subjectiveCase.task)).toEqual(['hook', 'style', 'voice', 'rewrite']);
    expect(report.cases.map((subjectiveCase) => subjectiveCase.score)).toEqual([94, 90, 90, 91]);
    expect(report.cases.every((subjectiveCase) => subjectiveCase.violations.length === 0)).toBe(true);
  });

  it('evaluates rubric fixture scores and preserves weighted metrics', () => {
    type RubricFixture = {
      cases: Array<{
        id: string;
        rubric: SubjectiveRubric;
        scores: Record<string, number>;
        expectedScore: number;
      }>;
    };
    const fixture = readFixture<RubricFixture>('subjective/rubric.json');
    const reports = fixture.cases.map((subjectiveCase) =>
      evaluateSubjectiveRubric({ rubric: subjectiveCase.rubric, scores: subjectiveCase.scores })
    );

    expect(reports.map((report) => report.score)).toEqual(
      fixture.cases.map((subjectiveCase) => subjectiveCase.expectedScore)
    );
    expect(reports.every((report) => report.passed)).toBe(true);
    expect(reports[0]?.metrics.weightedScore).toBe(87);
    expect(reports[1]?.metrics.weightedScore).toBe(90.5);
  });

  it('derives a reproducible pairwise ranking and accuracy from fixture scores', () => {
    const fixture = readFixture<SubjectivePairwiseSet>('subjective/pairwise.json');
    const report = evaluateSubjectivePairwise(fixture);
    const repeat = evaluateSubjectivePairwise(structuredClone(fixture));

    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
    expect(report.metrics).toMatchObject({
      comparisonCount: 6,
      validComparisonCount: 6,
      correctComparisonCount: 6,
      accuracyPercent: 100,
      tieCount: 1,
      candidateCount: 5
    });
    expect(report.ranking.map((entry) => entry.candidateId)).toEqual([
      'hook-strong',
      'rewrite-polished',
      'style-balanced',
      'hook-plain',
      'hook-weak'
    ]);
    expect(report.ranking[0]).toMatchObject({ rank: 1, score: 100, wins: 3, losses: 0 });
    expect(report.ranking[1]).toMatchObject({ rank: 2, ties: 1 });
    expect(report.ranking).toEqual(repeat.ranking);
    expect(report.metrics).toEqual(repeat.metrics);
  });
});

describe('Phase 18 long-context metric fixtures', () => {
  it.each([
    ['100-chapters.json', 100, 300],
    ['300-chapters.json', 300, 900]
  ])('keeps %s metrics reproducible without a provider', (fixtureName, chapterCount, estimatedTokens) => {
    type LongContextFixture = LongContextEvaluationInput & {
      id: string;
      expected: { anchorRecall: number; pruningWithinBudget: boolean };
    };
    const fixture = readFixture<LongContextFixture>(`long-context/${fixtureName}`);
    const benchmark = {
      ...fixture,
      chapters: Array.from({ length: chapterCount }, (_, index) => ({
        chapter: index + 1,
        text: `chapter-${index + 1}`
      }))
    };
    const report = evaluateLongContextBenchmark(benchmark);
    const repeat = evaluateLongContextBenchmark(structuredClone(benchmark));

    expect(report.passed).toBe(true);
    expect(report.metrics).toMatchObject({
      chapterCount,
      maxTokens: 2048,
      estimatedTokens,
      prunedChapterCount: 0,
      anchorRecallPercent: fixture.expected.anchorRecall * 100,
      cacheHitRatePercent: 0
    });
    expect(report.retainedChapterCount).toBe(chapterCount);
    expect(report.anchorRecall).toBe(fixture.expected.anchorRecall);
    expect(report.checkpointValid).toBe(true);
    expect(report.metrics).toEqual(repeat.metrics);
    expect(report.selectedChapters).toEqual(repeat.selectedChapters);
  });
});
