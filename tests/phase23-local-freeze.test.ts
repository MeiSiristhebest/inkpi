import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TaskObservability } from '@inkpi/agent-core';
import {
  type LongContextFixtureDefinition,
  PHASE18_LOCAL_FIXTURE_CONTRACT,
  PHASE18_OBJECTIVE_KINDS,
  PHASE19_OBSERVABILITY_FIELDS,
  PHASE22_RELIABILITY_SCENARIOS,
  PHASE23_ATOMIC_CONDITIONS,
  type Phase18MutationCase,
  type Phase18ObjectiveAssertion,
  createTaskEvalFixtures,
  evaluatePhase18MutationTests,
  evaluatePhase18ObjectiveAssertions,
  evaluatePhase23LocalGate,
  evaluateTaskCase,
  runDeterministicTaskFixture,
  runLongContextDeterministicBenchmarkSuite
} from '@inkpi/evals';
import type { AiTask } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

const REPOSITORY_ROOT = resolve(fileURLToPath(new URL('../', import.meta.url)));

function readFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(`../packages/evals/fixtures/${relativePath}`, import.meta.url), 'utf8')) as T;
}

function readRepositoryFile(relativePath: string): string {
  return readFileSync(resolve(REPOSITORY_ROOT, relativePath), 'utf8');
}

function assertLocalSourceMatrix(): void {
  for (const condition of PHASE23_ATOMIC_CONDITIONS) {
    for (const source of condition.sources) {
      expect(existsSync(resolve(REPOSITORY_ROOT, source.ref)), `${condition.id}: ${source.ref}`).toBe(true);
      expect(readRepositoryFile(source.ref), `${condition.id}: ${source.marker}`).toContain(source.marker);
    }
  }
  for (const scenario of PHASE22_RELIABILITY_SCENARIOS) {
    for (const source of scenario.sources) {
      expect(existsSync(resolve(REPOSITORY_ROOT, source.ref)), `${scenario.id}: ${source.ref}`).toBe(true);
      expect(readRepositoryFile(source.ref), `${scenario.id}: ${source.marker}`).toContain(source.marker);
    }
  }
}

function localChecks(): Array<{
  id: string;
  status: 'passed';
  sources: (typeof PHASE23_ATOMIC_CONDITIONS)[number]['sources'];
}> {
  return PHASE23_ATOMIC_CONDITIONS.map((condition) => ({
    id: condition.id,
    status: 'passed' as const,
    sources: condition.sources
  }));
}

function reliabilityChecks(): Array<{
  id: string;
  status: 'passed';
  sources: (typeof PHASE22_RELIABILITY_SCENARIOS)[number]['sources'];
}> {
  return PHASE22_RELIABILITY_SCENARIOS.map((scenario) => ({
    id: scenario.id,
    status: 'passed' as const,
    sources: scenario.sources
  }));
}

function deterministicPhase18Evidence(): {
  objectiveAssertions: Phase18ObjectiveAssertion[];
  mutationTests: Phase18MutationCase[];
} {
  const objectiveAssertions: Phase18ObjectiveAssertion[] = [
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
  const mutationTests = objectiveAssertions.map((assertion) => ({
    id: `${assertion.id}-mutation`,
    kind: assertion.kind,
    baseline: assertion.baseline,
    mutated: assertion.candidate,
    repaired: assertion.baseline
  }));
  return { objectiveAssertions, mutationTests };
}

describe('Phase 23 local atomic freeze gate', () => {
  it('maps every original Phase 23 checkbox to local test or fixture sources', () => {
    assertLocalSourceMatrix();

    expect(PHASE23_ATOMIC_CONDITIONS.map((condition) => condition.id)).toEqual([
      'canonical-content',
      'canonical-story-model',
      'continue-prose',
      'selection-rewrite',
      'continuity-audit',
      'deep-story-reasoning',
      'project-distillation',
      'projection-sync',
      'proposal-commit',
      'optimistic-concurrency',
      'durable-execution',
      'context-pipeline',
      'story-context-compiler',
      'skill-lazy-loading',
      'artifact-store',
      'cache-architecture',
      'capability-aware-model-routing',
      'evals-in-ci',
      'observability',
      'legacy-ai-paths'
    ]);
    expect(PHASE23_ATOMIC_CONDITIONS).toHaveLength(20);
    expect(PHASE22_RELIABILITY_SCENARIOS).toHaveLength(13);

    const report = evaluatePhase23LocalGate({
      checks: localChecks(),
      reliability: reliabilityChecks(),
      externalEvidence: [
        { id: 'evals', source: 'external', status: 'passed' },
        { id: 'observability', source: 'replay', status: 'passed' }
      ]
    });

    expect(report).toMatchObject({
      kind: 'phase23-local-atomic-gate',
      mode: 'deterministic-local',
      status: 'passed',
      eligible: true,
      atomicConditionCount: 20,
      passedConditionCount: 20,
      missingConditions: [],
      failedConditions: [],
      invalidConditions: [],
      reliability: {
        requiredCount: 13,
        passedCount: 13,
        missing: [],
        failed: [],
        invalid: []
      },
      externalEvidence: {
        policy: 'supplemental-only',
        ignoredCount: 2,
        usedForEligibility: false
      }
    });
  });

  it('does not promote external or replay records into local evidence', () => {
    const report = evaluatePhase23LocalGate({
      checks: [
        {
          id: 'canonical-content',
          status: 'passed',
          sources: [
            {
              kind: 'test',
              ref: 'inkpi-evidence/phase23/old-record.json',
              marker: 'status: passed'
            }
          ]
        }
      ]
    });

    expect(report.eligible).toBe(false);
    expect(report.invalidConditions).toContain('canonical-content');
    expect(report.missingConditions).toContain('canonical-story-model');
    expect(report.externalEvidence.usedForEligibility).toBe(false);
  });

  it('keeps the gate pending when one atomic condition or reliability scenario is absent', () => {
    const report = evaluatePhase23LocalGate({
      checks: localChecks().filter((check) => check.id !== 'artifact-store'),
      reliability: reliabilityChecks().filter((check) => check.id !== 'cache-invalidation')
    });

    expect(report).toMatchObject({ status: 'pending', eligible: false });
    expect(report.missingConditions).toEqual(['artifact-store']);
    expect(report.reliability.missing).toEqual(['cache-invalidation']);
  });

  it('runs all seven objective and mutation checks plus 100/300 fixture benchmarks without a provider', () => {
    const { objectiveAssertions, mutationTests } = deterministicPhase18Evidence();
    const objective = evaluatePhase18ObjectiveAssertions(objectiveAssertions);
    const mutation = evaluatePhase18MutationTests(mutationTests);
    const fixtures = [100, 300].map((chapterCount) =>
      readFixture<LongContextFixtureDefinition>(`long-context/${chapterCount}-chapters.json`)
    );
    const longContext = runLongContextDeterministicBenchmarkSuite(fixtures);

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
    expect(longContext).toMatchObject({
      mode: 'fixture-only',
      providerCalls: 0,
      modelCalls: 0,
      passed: true,
      metrics: {
        benchmarkCount: 2,
        chapterCounts: [100, 300],
        allPruningWithinBudget: true,
        minimumRetrievalRecall: 1,
        allCacheHitRatesMeetGate: true,
        allDistillationRecoveriesMatch: true,
        allGatesPass: true
      }
    });
    expect(PHASE18_LOCAL_FIXTURE_CONTRACT).toMatchObject({
      mode: 'fixture-only',
      providerCalls: 0,
      modelCalls: 0,
      objectiveKindCount: 7,
      mutationKindCount: 7,
      chapterCounts: [100, 300],
      evidenceRole: 'deterministic-regression-only',
      realProviderEvidence: 'not-produced',
      humanLabelEvidence: 'not-produced'
    });
  });

  it('covers the Phase 18 five task contracts through the deterministic Runtime fixture', async () => {
    const reports = await Promise.all(
      createTaskEvalFixtures().map(async ({ task, expectedFormat, requiredProvenanceKeys }) => {
        const result = await runDeterministicTaskFixture(task);
        return evaluateTaskCase({
          task,
          result,
          expected: {
            status: 'completed',
            outputFormat: expectedFormat,
            requiredProvenanceKeys
          }
        });
      })
    );

    expect(reports).toHaveLength(5);
    expect(reports.map((report) => report.kind)).toEqual([
      'creative.continue',
      'creative.rewrite',
      'narrative.continuity.audit',
      'narrative.deep.reason',
      'narrative.project.distill'
    ]);
    expect(reports.every((report) => report.passed && report.score === 100)).toBe(true);
  });

  it('requires every Phase 19 observation field and removes nested private reasoning', () => {
    const observer = new TaskObservability({ now: () => 100, sampleRate: 1, random: () => 0 });
    const task: AiTask = {
      id: 'phase23-observability-contract',
      kind: 'phase23.observability',
      input: { text: 'local deterministic input' },
      metadata: {
        executionRunId: 'run:phase23',
        instructionId: 'instruction:phase23',
        instructionVersion: 'v1',
        skillIds: ['skill:phase23'],
        skillVersions: { 'skill:phase23': '1.0.0' },
        provider: 'fixture-provider',
        model: 'fixture-model'
      }
    };
    observer.started(task);
    observer.contextBuilt(task, {
      fragments: [{ id: 'selection', source: 'selection' }],
      text: 'local context',
      tokenEstimate: 2,
      fingerprint: 'phase23-context-fingerprint',
      truncated: false,
      projectRevision: 7
    });
    observer.finished(task, {
      taskId: task.id,
      kind: task.kind,
      executionRunId: 'run:phase23',
      attempt: 1,
      status: 'completed',
      startedAt: 100,
      finishedAt: 140,
      progress: 1,
      contextFingerprint: 'phase23-context-fingerprint',
      contextSources: ['selection'],
      contextTokenCount: 2,
      projectRevision: 7,
      instructionId: 'instruction:phase23',
      routeId: 'route:fixture',
      instructionVersion: 'v1',
      skillIds: ['skill:phase23'],
      skillVersions: { 'skill:phase23': '1.0.0' },
      provider: 'fixture-provider',
      model: 'fixture-model',
      latencyMs: 40,
      usage: { inputTokens: 2, outputTokens: 3 },
      cache: { hit: false },
      tools: ['fixture-tool'],
      resultType: 'structured',
      artifactIds: ['artifact:phase23'],
      proposalIds: ['proposal:phase23'],
      checkpointIds: ['checkpoint:phase23'],
      provenance: {
        publicSummary: 'safe summary',
        rawThinking: 'must not persist',
        trace: { chainOfThought: 'must not persist' },
        apiKey: 'must not persist'
      }
    });

    const observation = observer.get(task.id);
    expect(observation).toBeDefined();
    for (const field of PHASE19_OBSERVABILITY_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(observation, field), field).toBe(true);
    }
    expect(observation?.provenance).toMatchObject({ publicSummary: 'safe summary', trace: {} });
    expect(JSON.stringify(observation)).not.toContain('must not persist');
    expect(JSON.stringify(observation)).not.toContain('rawThinking');
    expect(JSON.stringify(observation)).not.toContain('apiKey');
  });
});
