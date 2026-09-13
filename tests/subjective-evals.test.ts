import { readFileSync } from 'node:fs';
import {
  type LongContextEvaluationInput,
  type LongContextFixtureDefinition,
  PHASE18_OBJECTIVE_KINDS,
  type Phase18AcceptanceInput,
  type Phase18RealLongContextBenchmarkInput,
  REAL_PROVIDER_ACCEPTANCE_MARKER,
  type SubjectiveGoldSet,
  type SubjectiveHumanGoldSet,
  type SubjectiveHumanPairwiseSet,
  type SubjectivePairwiseSet,
  type SubjectiveRubric,
  createLongContextBenchmarkChapters,
  evaluateLongContextBenchmark,
  evaluatePhase18MutationTests,
  evaluatePhase18ObjectiveAssertions,
  evaluateSubjectiveGoldSet,
  evaluateSubjectivePairwise,
  evaluateSubjectiveRubric,
  phase18EvidenceDigest,
  pruneLongContextChapters,
  readPhase18AcceptanceInput,
  readRealProviderAcceptancePlan,
  runPhase18AcceptanceFromEnvironment,
  runPhase18AcceptanceGate,
  validatePhase18AcceptanceInput,
  validateSubjectiveHumanPairwiseSet
} from '@inkpi/evals';
import { describe, expect, it } from 'vitest';

function readFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(`../packages/evals/fixtures/${relativePath}`, import.meta.url), 'utf8')) as T;
}

function createPhase18DeterministicEvidence(): Pick<Phase18AcceptanceInput, 'objectiveAssertions' | 'mutationTests'> {
  const objectiveAssertions: Phase18AcceptanceInput['objectiveAssertions'] = [
    {
      id: 'dead-character-reappearance',
      kind: 'dead-character-reappearance',
      baseline: { facts: [{ entity: '林舟', status: 'dead' }], event: { entity: '林舟', action: 'waits' } },
      candidate: { facts: [{ entity: '林舟', status: 'dead' }], event: { entity: '林舟', action: 'returns' } },
      expected: 'fail'
    },
    {
      id: 'timeline-contradiction',
      kind: 'timeline-contradiction',
      baseline: {
        events: [
          { id: 'e1', at: 1 },
          { id: 'e2', at: 2, dependsOn: 'e1' }
        ]
      },
      candidate: {
        events: [
          { id: 'e1', at: 1 },
          { id: 'e2', at: 0, dependsOn: 'e1' }
        ]
      },
      expected: 'fail'
    },
    {
      id: 'entity-contradiction',
      kind: 'entity-contradiction',
      baseline: { facts: [{ entity: '苏棠', status: 'injured' }], claims: [{ entity: '苏棠', action: 'waits' }] },
      candidate: { facts: [{ entity: '苏棠', status: 'injured' }], claims: [{ entity: '苏棠', status: 'dead' }] },
      expected: 'fail'
    },
    {
      id: 'missing-payoff',
      kind: 'missing-payoff',
      baseline: { promise: { id: 'p1', status: 'open', resolveBy: 10 }, currentChapter: 5 },
      candidate: { promise: { id: 'p1', status: 'open', resolveBy: 10 }, currentChapter: 11 },
      expected: 'fail'
    },
    {
      id: 'invalid-state-transition',
      kind: 'invalid-state-transition',
      baseline: {
        initial: { 林舟: 'alive' },
        transitions: [{ entity: '林舟', from: 'alive', to: 'injured' }],
        allowedTransitions: { alive: ['injured'], injured: ['dead'] }
      },
      candidate: {
        initial: { 林舟: 'alive' },
        transitions: [{ entity: '林舟', from: 'alive', to: 'dead' }],
        allowedTransitions: { alive: ['injured'], injured: ['dead'] }
      },
      expected: 'fail'
    },
    {
      id: 'incorrect-retrieval',
      kind: 'incorrect-retrieval',
      baseline: { expected: ['anchor-a', 'anchor-b'], actual: ['anchor-a', 'anchor-b'] },
      candidate: { expected: ['anchor-a', 'anchor-b'], actual: ['anchor-a', 'wrong-anchor'] },
      expected: 'fail'
    },
    {
      id: 'range-source-map-failure',
      kind: 'range-source-map-failure',
      baseline: {
        semanticLength: 5,
        editorLength: 8,
        segments: [{ blockId: 'paragraph-1', semanticFrom: 0, semanticTo: 5, editorFrom: 3, editorTo: 8 }],
        ranges: [{ editor: { from: 3, to: 8 }, semantic: { from: 0, to: 5 } }]
      },
      candidate: {
        semanticLength: 5,
        editorLength: 8,
        segments: [{ blockId: 'paragraph-1', semanticFrom: 0, semanticTo: 5, editorFrom: 3, editorTo: 8 }],
        ranges: [{ editor: { from: 3, to: 99 }, semantic: { from: 0, to: 5 } }]
      },
      expected: 'fail'
    }
  ];
  const mutationTests: Phase18AcceptanceInput['mutationTests'] = objectiveAssertions.map((assertion) => ({
    id: `${assertion.id}-mutation`,
    kind: assertion.kind,
    baseline: assertion.baseline,
    mutated: assertion.candidate,
    repaired: assertion.baseline
  }));
  return { objectiveAssertions, mutationTests };
}

function createPhase18TestInput(): Phase18AcceptanceInput {
  const goldFixture = readFixture<SubjectiveGoldSet>('subjective/gold-set.json');
  const pairwiseFixture = readFixture<SubjectivePairwiseSet>('subjective/pairwise.json');
  const provenance = {
    source: 'human-labelled' as const,
    datasetId: 'phase18-unit-test-human-labels',
    version: 'test-v1',
    annotatorIds: ['annotator-a'],
    annotationCount: goldFixture.cases.length,
    annotatedAt: '2026-09-12T00:00:00.000Z',
    adjudication: { status: 'not-required' as const, reason: 'deterministic unit fixture' }
  };
  const goldSet: SubjectiveHumanGoldSet = {
    ...goldFixture,
    provenance,
    annotations: goldFixture.cases.map((subjectiveCase) => ({
      caseId: subjectiveCase.id ?? '',
      annotatorId: 'annotator-a',
      label: 'accepted',
      score: subjectiveCase.candidate.score
    }))
  };
  const pairwiseProvenance = {
    ...provenance,
    annotationCount: pairwiseFixture.comparisons.length
  };
  const pairwise: SubjectiveHumanPairwiseSet = {
    ...pairwiseFixture,
    requireExplicitObservedPreference: true,
    provenance: pairwiseProvenance,
    comparisons: pairwiseFixture.comparisons.map((comparison) => ({
      ...comparison,
      observedPreference: comparison.expectedPreference
    })),
    annotations: pairwiseFixture.comparisons.map((comparison) => ({
      comparisonId: comparison.id ?? '',
      annotatorId: 'annotator-a',
      preference: comparison.expectedPreference ?? ''
    }))
  };
  const { objectiveAssertions, mutationTests } = createPhase18DeterministicEvidence();
  const benchmarks = [100, 300].map((chapterCount): Phase18RealLongContextBenchmarkInput => {
    const fixture = readFixture<LongContextFixtureDefinition>(`long-context/${chapterCount}-chapters.json`);
    const chapters = createLongContextBenchmarkChapters(chapterCount);
    const retainedChapters = pruneLongContextChapters(
      chapters,
      fixture.maxTokens,
      fixture.anchorChapters
    ).selectedChapters;
    return {
      ...fixture,
      mode: 'real-provider',
      chapters,
      observations: {
        source: 'runtime',
        runId: `unit-test-runtime-${chapterCount}`,
        retainedChapters,
        cacheLookups: [
          { key: `context:${chapterCount}`, hit: false },
          { key: `context:${chapterCount}`, hit: true },
          { key: `retrieval:${chapterCount}`, hit: false },
          { key: `retrieval:${chapterCount}`, hit: true }
        ],
        recovery: { attempted: true, recoveredChapter: fixture.checkpoint.nextChapter }
      },
      responseContract: {
        expectedRetrievedAnchors: fixture.anchorChapters,
        expectedRecoveredChapter: fixture.checkpoint.nextChapter
      }
    };
  });
  const input = {
    id: 'phase18-unit-test-input',
    mode: 'real-provider' as const,
    objectiveAssertions,
    mutationTests,
    goldSet,
    pairwise,
    benchmarks
  };
  return {
    ...input,
    attestation: {
      schemaVersion: 1 as const,
      producer: 'unit-test-assembler',
      capturedAt: '2026-09-13T00:00:00.000Z',
      inputDigest: phase18EvidenceDigest(input)
    }
  };
}

function reattestPhase18Input(
  input: Phase18AcceptanceInput,
  changes: Partial<Phase18AcceptanceInput>
): Phase18AcceptanceInput {
  const next = { ...input, ...changes };
  const { attestation: _attestation, ...withoutAttestation } = next;
  return {
    ...next,
    attestation: {
      ...next.attestation,
      inputDigest: phase18EvidenceDigest(withoutAttestation)
    }
  };
}

describe('Phase 18 subjective eval fixtures', () => {
  it('evaluates hook, style, voice, commercial tension, and rewrite-quality gold contracts', () => {
    const fixture = readFixture<SubjectiveGoldSet>('subjective/gold-set.json');
    const report = evaluateSubjectiveGoldSet(fixture);

    expect(report.passed).toBe(true);
    expect(report.score).toBe(90);
    expect(report.metrics).toMatchObject({
      caseCount: 6,
      passedCaseCount: 6,
      failedCaseCount: 0,
      passRatePercent: 100,
      averageScore: 90,
      threshold: 85
    });
    expect(report.cases.map((subjectiveCase) => subjectiveCase.task)).toEqual([
      'hook',
      'style',
      'voice',
      'rewrite',
      'commercial-tension',
      'rewrite-quality'
    ]);
    expect(report.cases.map((subjectiveCase) => subjectiveCase.score)).toEqual([94, 90, 90, 91, 88, 89]);
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

describe('Phase 18 executable evidence gates', () => {
  it('returns skipped without an explicit input source and never falls back to fixtures', async () => {
    expect(readPhase18AcceptanceInput({})).toMatchObject({ status: 'skipped' });
    const report = await runPhase18AcceptanceFromEnvironment({
      env: {},
      runProvider: async () => {
        throw new Error('provider must not be called');
      },
      timestamp: 100
    });

    expect(report).toMatchObject({ status: 'skipped', passed: false, timestamp: 100 });
  });

  it('rejects the checked-in fixture envelope instead of treating it as human or real evidence', async () => {
    const fixture = readFixture<unknown>('phase18/fixture-only-input.json');
    const validation = validatePhase18AcceptanceInput(fixture);
    expect(validation.passed).toBe(false);
    expect(validation.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        'phase18-real-mode-required',
        'human-gold-provenance-missing',
        'human-pairwise-observed-missing',
        'benchmark-0-fixture-only',
        'benchmark-1-fixture-only'
      ])
    );

    const providerPlan = readRealProviderAcceptancePlan({
      INKPI_RUN_REAL_PROVIDER_ACCEPTANCE: '1',
      INKPI_ACCEPTANCE_PROVIDER: 'openai',
      INKPI_ACCEPTANCE_MODEL: 'unit-test-model',
      OPENAI_API_KEY: 'unit-test-secret'
    });
    let providerCalled = false;
    const report = await runPhase18AcceptanceGate({
      input: fixture,
      providerPlan,
      runProvider: async () => {
        providerCalled = true;
        return { success: true, content: REAL_PROVIDER_ACCEPTANCE_MARKER, durationMs: 1 };
      }
    });

    expect(report.status).toBe('failed');
    expect(report.passed).toBe(false);
    expect(providerCalled).toBe(false);
  });

  it('requires an integrity attestation for the assembled real-evidence envelope', () => {
    const input = createPhase18TestInput();
    expect(validatePhase18AcceptanceInput(input).passed).toBe(true);

    const tampered = { ...input, id: 'tampered-after-capture' };
    expect(validatePhase18AcceptanceInput(tampered).violations.map((violation) => violation.code)).toContain(
      'phase18-attestation-digest-mismatch'
    );

    const { attestation: _attestation, ...withoutAttestation } = input;
    expect(validatePhase18AcceptanceInput(withoutAttestation).violations.map((violation) => violation.code)).toContain(
      'phase18-attestation-missing'
    );
  });

  it('evaluates every Phase 18 objective kind and mutation triplet from computed results', () => {
    const input = createPhase18TestInput();
    const validation = validatePhase18AcceptanceInput(input);
    expect(validation.passed).toBe(true);
    expect(validation.metrics).toMatchObject({
      objectiveAssertionCount: PHASE18_OBJECTIVE_KINDS.length,
      objectiveKinds: expect.arrayContaining([...PHASE18_OBJECTIVE_KINDS]),
      mutationTestCount: PHASE18_OBJECTIVE_KINDS.length,
      mutationKinds: expect.arrayContaining([...PHASE18_OBJECTIVE_KINDS])
    });

    const objective = evaluatePhase18ObjectiveAssertions(input.objectiveAssertions);
    const mutation = evaluatePhase18MutationTests(input.mutationTests);
    expect(objective).toMatchObject({
      status: 'passed',
      passed: true,
      metrics: {
        assertionCount: PHASE18_OBJECTIVE_KINDS.length,
        passedAssertionCount: PHASE18_OBJECTIVE_KINDS.length,
        coveredKindCount: PHASE18_OBJECTIVE_KINDS.length,
        requiredKindCount: PHASE18_OBJECTIVE_KINDS.length
      }
    });
    expect(mutation).toMatchObject({
      status: 'passed',
      passed: true,
      metrics: {
        caseCount: PHASE18_OBJECTIVE_KINDS.length,
        passedCaseCount: PHASE18_OBJECTIVE_KINDS.length,
        coveredKindCount: PHASE18_OBJECTIVE_KINDS.length,
        requiredKindCount: PHASE18_OBJECTIVE_KINDS.length
      }
    });
    expect(objective.reports.every((report) => report.baselinePassed && !report.candidatePassed)).toBe(true);
    expect(
      mutation.reports.every(
        (report) => !report.baselineDetected && report.mutationDetected && !report.repairedDetected
      )
    ).toBe(true);
  });

  it.each([
    ['baseline false positive', 'objective', 'objective-0-baseline-false-positive'],
    ['mutation not detected', 'mutation', 'mutation-not-detected'],
    ['repair false positive', 'repair', 'mutation-repair-false-positive']
  ])('fails the deterministic gate for %s even when a caller reports passed', async (_name, failure, code) => {
    const input = createPhase18TestInput();
    const firstObjective = input.objectiveAssertions[0];
    const firstMutation = input.mutationTests[0];
    const variant =
      failure === 'objective'
        ? reattestPhase18Input(input, {
            objectiveAssertions: input.objectiveAssertions.map((assertion, index) =>
              index === 0 ? { ...assertion, baseline: firstObjective.candidate, passed: true } : assertion
            )
          })
        : reattestPhase18Input(input, {
            mutationTests: input.mutationTests.map((mutationCase, index) =>
              index === 0
                ? {
                    ...mutationCase,
                    ...(failure === 'mutation'
                      ? { mutated: firstMutation.baseline }
                      : { repaired: firstMutation.mutated }),
                    passed: true
                  }
                : mutationCase
            )
          });

    const report = await runPhase18AcceptanceGate({ input: variant });
    expect(report.status).toBe('failed');
    expect(report.passed).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toContain(code);
  });

  it('rejects incomplete and malformed deterministic evidence before execution', () => {
    const input = createPhase18TestInput();
    const variant = reattestPhase18Input(input, {
      objectiveAssertions: input.objectiveAssertions.slice(0, -1),
      mutationTests: input.mutationTests.map((mutationCase, index) =>
        index === 0 ? { ...mutationCase, repaired: { invalid: true } } : mutationCase
      )
    });
    const validation = validatePhase18AcceptanceInput(variant);
    const codes = validation.violations.map((violation) => violation.code);
    expect(validation.passed).toBe(false);
    expect(codes).toContain('objective-range-source-map-failure-missing');
    expect(codes).toContain('mutation-0-repaired-invalid');
  });

  it('requires provenance, annotations, and explicit observations for pairwise evidence', () => {
    const fixture = readFixture<SubjectivePairwiseSet>('subjective/pairwise.json');
    const report = validateSubjectiveHumanPairwiseSet(fixture);
    expect(report.passed).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(['human-gold-provenance-missing', 'human-pairwise-observed-missing'])
    );
  });

  it('executes both real benchmark sizes through the provider boundary and redacts private output', async () => {
    const input = createPhase18TestInput();
    const providerPlan = readRealProviderAcceptancePlan({
      INKPI_RUN_REAL_PROVIDER_ACCEPTANCE: '1',
      INKPI_ACCEPTANCE_PROVIDER: 'openai',
      INKPI_ACCEPTANCE_MODEL: 'unit-test-model',
      OPENAI_API_KEY: 'unit-test-secret'
    });
    expect(providerPlan.status).toBe('ready');
    if (providerPlan.status !== 'ready') throw new Error('Expected a ready test provider plan.');

    const prompts: string[] = [];
    const report = await runPhase18AcceptanceGate({
      input,
      providerPlan,
      timestamp: 200,
      runProvider: async ({ prompt }) => {
        prompts.push(prompt);
        const chapterCount = prompts.length === 1 ? 100 : 300;
        const benchmark = input.benchmarks.find((candidate) => candidate.chapterCount === chapterCount);
        if (!benchmark) throw new Error('Missing benchmark fixture.');
        return {
          success: true,
          content: `<think>unit-test-secret private chain of thought</think>${JSON.stringify({
            marker: REAL_PROVIDER_ACCEPTANCE_MARKER,
            retrievedAnchors: benchmark.responseContract.expectedRetrievedAnchors,
            recoveredChapter: benchmark.responseContract.expectedRecoveredChapter
          })}`,
          durationMs: 4
        };
      }
    });

    expect(report).toMatchObject({
      kind: 'phase18-acceptance',
      status: 'passed',
      passed: true,
      timestamp: 200,
      provider: { provider: 'openai', model: 'unit-test-model' },
      subjective: { status: 'passed' },
      longContext: {
        passed: true,
        providerCalls: 2,
        modelCalls: 2,
        metrics: { benchmarkCount: 2, chapterCounts: [100, 300] }
      }
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain('CHAPTER 100');
    expect(prompts[1]).toContain('CHAPTER 300');
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain('unit-test-secret');
    expect(serialized).not.toContain('<think>');
  });
});
