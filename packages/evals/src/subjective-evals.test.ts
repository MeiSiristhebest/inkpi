import { describe, expect, it } from 'vitest';
import {
  SubjectiveGoldSetEvaluator,
  SubjectivePairwiseEvaluator,
  SubjectiveRubricEvaluator,
  evaluateSubjectiveGoldCase,
  evaluateSubjectiveGoldSet,
  evaluateSubjectivePairwise,
  evaluateSubjectiveRubric
} from './subjective-evals.js';

const rubric = {
  id: 'test-rubric',
  threshold: 85,
  criteria: [
    { id: 'clarity', weight: 2, minScore: 80, required: true },
    { id: 'voice', weight: 1, minScore: 80, required: true },
    { id: 'risk', weight: 1 }
  ]
} as const;

describe('subjective rubric evaluator', () => {
  it('calculates weighted scores and exposes the class adapter', () => {
    const input = {
      rubric,
      scores: { clarity: 90, voice: 86, risk: 82 }
    };
    const report = evaluateSubjectiveRubric(input);

    expect(report).toMatchObject({ rubricId: 'test-rubric', score: 87, passed: true });
    expect(report.metrics).toMatchObject({ criterionCount: 3, scoredCriterionCount: 3, requiredFailureCount: 0 });
    expect(report.metrics.weightedScore).toBe(87);
    expect(new SubjectiveRubricEvaluator().evaluate(input)).toEqual(report);
  });

  it('supports the legacy rubric array field and reports score boundaries', () => {
    const legacy = evaluateSubjectiveRubric({
      rubric: { id: 'legacy', rubric: ['clarity', 'tension'], threshold: 85 },
      rubricScores: { clarity: 85, tension: 84, extra: 100 }
    });
    expect(legacy.score).toBe(85);
    expect(legacy.passed).toBe(true);
    expect(legacy.metrics.extraScoreCount).toBe(1);

    const requiredFailure = evaluateSubjectiveRubric({
      rubric: {
        threshold: 85,
        criteria: [{ id: 'required', required: true, minScore: 90 }, { id: 'optional' }]
      },
      scores: { required: 89, optional: 100 }
    });
    expect(requiredFailure.passed).toBe(false);
    expect(requiredFailure.metrics.requiredFailureCount).toBe(1);
    expect(requiredFailure.violations).toEqual([]);

    const invalid = evaluateSubjectiveRubric({
      rubric: {
        threshold: 101,
        criterionThreshold: -1,
        criteria: [{ id: 'bad-weight', weight: -1, minScore: 101 }, { id: 'missing' }, { id: 'missing' }]
      },
      scores: { 'bad-weight': Number.NaN, extra: 80 }
    });
    expect(invalid.passed).toBe(false);
    expect(invalid.score).toBe(0);
    expect(invalid.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'rubric-threshold-invalid',
        'criterion-threshold-invalid',
        'criterion-weight-invalid',
        'criterion-min-score-invalid',
        'criterion-score-invalid',
        'criterion-score-missing',
        'criterion-duplicate',
        'rubric-score-below-threshold'
      ])
    );

    const empty = evaluateSubjectiveRubric({ rubric: { id: 'empty', criteria: [] }, scores: {} });
    expect(empty.passed).toBe(false);
    expect(empty.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(['rubric-empty', 'rubric-weight-empty', 'rubric-score-below-threshold'])
    );
  });
});

describe('subjective gold-set evaluator', () => {
  const goodCase = {
    id: 'hook-case',
    task: 'hook' as const,
    candidate: {
      id: 'hook-candidate',
      text: '倒计时已经开始，门后传来脚步声。',
      format: 'text',
      labels: ['tension'],
      score: 90
    },
    gold: {
      expectedScore: 90,
      expectedFormat: 'text',
      requiredPhrases: ['倒计时'],
      forbiddenPhrases: ['天气很好'],
      requiredLabels: ['tension']
    }
  };

  it('checks text, label, format, and score contracts without a provider', () => {
    const report = evaluateSubjectiveGoldCase(goodCase);
    expect(report.passed).toBe(true);
    expect(report.score).toBe(90);
    expect(report.violations).toEqual([]);

    const rubricCase = evaluateSubjectiveGoldCase({
      id: 'voice-case',
      task: 'voice',
      candidate: { rubricScores: { vocabulary: 90, uncertainty: 88 } },
      gold: {
        expectedScore: 89,
        scoreTolerance: 1,
        rubric: { criteria: ['vocabulary', 'uncertainty'], threshold: 85 },
        expectedRubricScores: { vocabulary: 90, uncertainty: 88 }
      }
    });
    expect(rubricCase.passed).toBe(true);
    expect(rubricCase.metrics.rubricScore).toBe(89);
  });

  it('reports every failed gold boundary and preserves the candidate score', () => {
    const invalid = evaluateSubjectiveGoldCase({
      ...goodCase,
      candidate: {
        ...goodCase.candidate,
        text: '天气很好。',
        format: 'patch',
        labels: [],
        score: 70
      },
      gold: {
        ...goodCase.gold,
        expectedScore: 90,
        minScore: 80,
        maxScore: 95,
        scoreTolerance: -1
      }
    });
    expect(invalid.passed).toBe(false);
    expect(invalid.score).toBe(70);
    expect(invalid.checks.requiredPhrases.passed).toBe(false);
    expect(invalid.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'score-tolerance-invalid',
        'score-contract-failed',
        'minimum-score-failed',
        'format-mismatch',
        'required-phrase-missing',
        'forbidden-phrase-found',
        'required-label-missing'
      ])
    );

    const invalidScore = evaluateSubjectiveGoldCase({
      id: 'invalid-score',
      task: 'rewrite',
      candidate: { score: 101 },
      gold: { expectedScore: 101 }
    });
    expect(invalidScore.passed).toBe(false);
    expect(invalidScore.score).toBe(0);
    expect(invalidScore.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(['candidate-score-invalid', 'expected-score-invalid', 'score-contract-failed'])
    );
  });

  it('aggregates cases and rejects an empty gold set', () => {
    const set = evaluateSubjectiveGoldSet({ id: 'set', threshold: 85, cases: [goodCase] });
    expect(set).toMatchObject({ id: 'set', score: 90, passed: true });
    expect(set.metrics).toMatchObject({ caseCount: 1, passedCaseCount: 1, passRatePercent: 100 });
    expect(set.caseReports).toBe(set.cases);
    expect(new SubjectiveGoldSetEvaluator().evaluate({ id: 'set', cases: [goodCase] })).toEqual(set);

    const empty = evaluateSubjectiveGoldSet({ id: 'empty', cases: [] });
    expect(empty.passed).toBe(false);
    expect(empty.score).toBe(0);
    expect(empty.violations.map((violation) => violation.code)).toContain('gold-set-empty');
  });
});

describe('subjective pairwise evaluator', () => {
  const set = {
    id: 'pairwise',
    threshold: 85,
    candidates: [
      { id: 'a', score: 95 },
      { id: 'b', score: 80 },
      { id: 'c', score: 80 }
    ],
    comparisons: [
      { id: 'a-b', left: 'a', right: 'b', expectedPreference: 'left' },
      { id: 'a-c', left: 'a', right: 'c', expectedPreference: 'a', observedPreference: 'a', weight: 2 },
      { id: 'b-c', left: 'b', right: 'c', expectedPreference: 'tie', observedPreference: 'draw' }
    ]
  } as const;

  it('derives preferences from scores, handles aliases, and ranks deterministically', () => {
    const report = evaluateSubjectivePairwise(set);
    expect(report).toMatchObject({ id: 'pairwise', score: 100, passed: true });
    expect(report.metrics).toMatchObject({
      comparisonCount: 3,
      validComparisonCount: 3,
      correctComparisonCount: 3,
      tieCount: 1,
      candidateCount: 3
    });
    expect(report.ranking.map((entry) => entry.candidateId)).toEqual(['a', 'b', 'c']);
    expect(report.ranking[0]).toMatchObject({ rank: 1, score: 100, wins: 2, losses: 0 });
    expect(report.ranking[1]).toMatchObject({ ties: 1, score: 25 });
    expect(new SubjectivePairwiseEvaluator().evaluate(set)).toEqual(report);
  });

  it('fails mismatches and malformed comparisons instead of inventing a preference', () => {
    const mismatch = evaluateSubjectivePairwise({
      id: 'mismatch',
      candidates: [
        { id: 'a', score: 90 },
        { id: 'b', score: 80 }
      ],
      comparisons: [{ left: 'a', right: 'b', expectedPreference: 'a', observedPreference: 'b' }]
    });
    expect(mismatch.passed).toBe(false);
    expect(mismatch.score).toBe(0);
    expect(mismatch.comparisons[0]?.passed).toBe(false);

    const malformed = evaluateSubjectivePairwise({
      id: 'malformed',
      candidates: [
        { id: 'a', score: 90 },
        { id: 'a', score: 90 },
        { id: 'bad', score: 101 }
      ],
      comparisons: [
        { id: 'missing-expected', left: 'a', right: 'b' },
        { id: 'same', left: 'a', right: 'a', expectedPreference: 'a' },
        { id: 'bad-weight', left: 'a', right: 'bad', expectedPreference: 'a', weight: -1 },
        { id: 'bad-observed', left: 'a', right: 'b', expectedPreference: 'a', observedPreference: 'unknown' }
      ]
    });
    expect(malformed.passed).toBe(false);
    expect(malformed.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'candidate-duplicate',
        'candidate-score-invalid',
        'observed-preference-missing',
        'expected-preference-invalid',
        'pairwise-same-candidate',
        'pairwise-weight-invalid',
        'observed-preference-invalid',
        'pairwise-weight-empty'
      ])
    );

    const noScores = evaluateSubjectivePairwise({
      id: 'no-scores',
      comparisons: [{ left: 'a', right: 'b', expectedPreference: 'a' }]
    });
    expect(noScores.passed).toBe(false);
    expect(noScores.violations.map((violation) => violation.code)).toContain('observed-preference-missing');

    const empty = evaluateSubjectivePairwise({ id: 'empty', comparisons: [] });
    expect(empty.passed).toBe(false);
    expect(empty.violations.map((violation) => violation.code)).toContain('pairwise-empty');
  });
});
