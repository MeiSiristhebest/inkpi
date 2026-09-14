import { describe, expect, it } from 'vitest';
import { type SubjectiveHumanGoldSet, validateSubjectiveHumanGoldSet } from './human-gold.js';
import { evaluateSubjectivePairwise } from './subjective-evals.js';

const validHumanGoldSet: SubjectiveHumanGoldSet = {
  id: 'human-gold-fixture-test',
  cases: [
    { id: 'hook-1', task: 'hook', candidate: { id: 'a', score: 90 }, gold: { expectedScore: 90 } },
    { id: 'voice-1', task: 'voice', candidate: { id: 'b', score: 88 }, gold: { expectedScore: 88 } }
  ],
  provenance: {
    source: 'human-labelled',
    datasetId: 'test-dataset',
    version: '2026-09-12.1',
    annotatorIds: ['annotator-a', 'annotator-b'],
    annotationCount: 2,
    annotatedAt: '2026-09-12T00:00:00.000Z',
    adjudication: { status: 'complete', adjudicatorId: 'adjudicator-a', decision: 'accepted' },
    agreement: { metric: 'krippendorff-alpha', score: 0.82, sampleCount: 2 }
  },
  annotations: [
    { caseId: 'hook-1', annotatorId: 'annotator-a', label: 'strong', score: 90 },
    { caseId: 'voice-1', annotatorId: 'annotator-b', label: 'strong', score: 88 }
  ]
};

describe('human-labelled gold set contract', () => {
  it('accepts a complete provenance and annotation envelope', () => {
    const report = validateSubjectiveHumanGoldSet(validHumanGoldSet);

    expect(report).toMatchObject({
      id: 'human-gold-fixture-test',
      passed: true,
      metrics: { caseCount: 2, annotationCount: 2, coveredCaseCount: 2, annotatorCount: 2 }
    });
    expect(report.violations).toEqual([]);
  });

  it('rejects missing provenance, uncovered cases, unknown annotators, and duplicates', () => {
    const invalid = {
      ...validHumanGoldSet,
      provenance: {
        ...validHumanGoldSet.provenance,
        source: 'deterministic-reference',
        annotationCount: 5
      },
      annotations: [
        { caseId: 'hook-1', annotatorId: 'annotator-a', label: 'strong', score: 90 },
        { caseId: 'missing-case', annotatorId: 'annotator-b', label: 'strong', score: 88 },
        { caseId: 'hook-1', annotatorId: 'unknown', label: 'unknown' },
        { caseId: 'hook-1', annotatorId: 'annotator-a', label: 'duplicate' }
      ]
    };

    const report = validateSubjectiveHumanGoldSet(invalid);
    expect(report.passed).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'human-gold-source-invalid',
        'human-gold-count-mismatch',
        'human-gold-annotation-case-invalid',
        'human-gold-annotation-annotator-invalid',
        'human-gold-annotation-duplicate',
        'human-gold-case-uncovered'
      ])
    );
  });

  it('rejects malformed provenance and annotation records', () => {
    const report = validateSubjectiveHumanGoldSet({
      id: 'malformed-human-gold',
      cases: [null, { id: 'duplicate-case' }, { id: 'duplicate-case' }],
      provenance: {
        source: 'fixture',
        datasetId: ' ',
        version: '',
        annotatedAt: 'not-a-timestamp',
        annotationCount: 0,
        annotatorIds: ['', 'annotator-a', 'annotator-a'],
        adjudication: { status: 'complete', decision: 'unknown' },
        agreement: { metric: '', score: 2, sampleCount: 0 }
      },
      annotations: [
        null,
        { caseId: 'unknown-case', annotatorId: 'unknown-annotator', label: '', score: 101 },
        { caseId: 'duplicate-case', annotatorId: 'annotator-a', label: 'first' },
        { caseId: 'duplicate-case', annotatorId: 'annotator-a', label: 'second' }
      ]
    });

    expect(report.passed).toBe(false);
    expect(report.metrics).toMatchObject({ caseCount: 3, annotationCount: 4, coveredCaseCount: 1 });
    expect(report.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'human-gold-source-invalid',
        'human-gold-provenance-field-missing',
        'human-gold-timestamp-invalid',
        'human-gold-count-invalid',
        'human-gold-annotator-invalid',
        'human-gold-annotator-duplicate',
        'human-gold-adjudicator-missing',
        'human-gold-decision-invalid',
        'human-gold-agreement-invalid',
        'human-gold-case-id-missing',
        'human-gold-case-duplicate',
        'human-gold-annotation-invalid',
        'human-gold-annotation-case-invalid',
        'human-gold-annotation-annotator-invalid',
        'human-gold-label-missing',
        'human-gold-score-invalid',
        'human-gold-annotation-duplicate'
      ])
    );
  });

  it('requires explicit metadata when optional provenance sections are malformed', () => {
    const report = validateSubjectiveHumanGoldSet({
      cases: [{ id: 'case-1' }],
      provenance: {
        source: 'human-labelled',
        datasetId: 'dataset',
        version: '1',
        annotatedAt: '2026-09-12T00:00:00.000Z',
        annotationCount: 1,
        adjudication: 'missing',
        agreement: 'missing'
      },
      annotations: [{ caseId: 'case-1', annotatorId: 'annotator-a', label: 'valid' }]
    });

    expect(report.passed).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'human-gold-annotators-missing',
        'human-gold-adjudication-invalid',
        'human-gold-agreement-invalid'
      ])
    );
  });

  it('rejects a not-required adjudication without a reason', () => {
    const report = validateSubjectiveHumanGoldSet({
      cases: [{ id: 'case-1' }],
      provenance: {
        source: 'human-labelled',
        datasetId: 'dataset',
        version: '1',
        annotatorIds: ['annotator-a'],
        annotationCount: 1,
        annotatedAt: '2026-09-12T00:00:00.000Z',
        adjudication: { status: 'not-required' }
      },
      annotations: [{ caseId: 'case-1', annotatorId: 'annotator-a', label: 'valid' }]
    });

    expect(report.passed).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toContain('human-gold-adjudication-reason-missing');
  });

  it('does not derive observed preference when explicit human labels are required', () => {
    const report = evaluateSubjectivePairwise({
      requireExplicitObservedPreference: true,
      candidates: [
        { id: 'a', score: 95 },
        { id: 'b', score: 80 }
      ],
      comparisons: [{ id: 'a-b', left: 'a', right: 'b', expectedPreference: 'a' }]
    });

    expect(report.passed).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toContain('observed-preference-required');
    expect(report.comparisons[0]?.observedPreference).toBeUndefined();
  });
});
