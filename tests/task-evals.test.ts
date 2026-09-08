import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type EntityContradictionInput,
  type InvalidStateTransitionInput,
  type LongContextEvaluationInput,
  type MutationEvaluationInput,
  type SourceMapRangeAssertion,
  type SourceMapRangeEvaluationInput,
  createLongContextBenchmark,
  evaluateEntityContradiction,
  evaluateInvalidStateTransition,
  evaluateLongContextBenchmark,
  evaluateMutationCase,
  evaluateSourceMapRanges,
  evaluateTaskCase,
  runMutationChecks
} from '@inkpi/evals';
import type { AiTask, TaskResult } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

function readFixture<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(`../packages/evals/fixtures/${relativePath}`, import.meta.url), 'utf8')) as T;
}

function listFixtureFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const file = join(root, entry);
    return statSync(file).isDirectory() ? listFixtureFiles(file) : file.endsWith('.json') ? [file] : [];
  });
}

describe('AI task evaluation contract', () => {
  it('scores status, output contract, provenance, and effect safety', () => {
    const task: AiTask = {
      id: 'eval-task',
      kind: 'creative.continue',
      input: {},
      outputContract: { format: 'text' },
      effectPolicy: { mode: 'proposal', requiresApproval: true }
    };
    const result: TaskResult = {
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      output: { format: 'text', text: '继续' },
      provenance: { contextFingerprint: 'abc' }
    };
    const report = evaluateTaskCase({
      task,
      result,
      expected: { requiredProvenanceKeys: ['contextFingerprint'] }
    });
    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
  });

  it('fails a contract mismatch instead of hiding it in a partial score', () => {
    const task: AiTask = {
      id: 'eval-task-fail',
      kind: 'creative.rewrite',
      input: {},
      outputContract: { format: 'patch' },
      effectPolicy: { mode: 'proposal' }
    };
    const report = evaluateTaskCase({
      task,
      result: { taskId: task.id, kind: task.kind, status: 'completed', output: { format: 'text', text: 'bad' } }
    });
    expect(report.passed).toBe(false);
    expect(report.checks.outputContract.passed).toBe(false);
    expect(report.checks.effectSafety.passed).toBe(false);
  });

  it('provides deterministic long-context and mutation evaluation helpers', () => {
    const benchmark = createLongContextBenchmark(300, 512);
    expect(benchmark.chapterCount).toBe(300);
    expect(benchmark.task.contextPolicy?.maxTokens).toBe(512);
    expect(
      runMutationChecks(
        benchmark.task,
        [
          {
            name: 'remove-budget',
            mutate: (task) => ({ ...task, contextPolicy: { maxTokens: 10 } }),
            expectedDetection: true
          }
        ],
        (task) => (task.contextPolicy?.maxTokens ?? 0) < 512
      )
    ).toEqual([{ name: 'remove-budget', passed: true }]);
  });

  it('detects entity contradictions and accepts the repaired facts', () => {
    const fixture = readFixture<EntityContradictionInput>('continuity/entity-contradiction.json');
    const report = evaluateEntityContradiction(fixture);

    expect(report.passed).toBe(false);
    expect(report.metrics.contradictionCount).toBeGreaterThanOrEqual(2);
    expect(report.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(['entity-action-contradiction', 'entity-status-contradiction'])
    );

    const ledgerReport = evaluateEntityContradiction({
      ledger: { entities: [{ name: '林舟', status: 'dead' }] },
      claims: [{ entity: '林舟', action: 'returns' }]
    });
    expect(ledgerReport.passed).toBe(false);

    const repaired = evaluateEntityContradiction({
      facts: fixture.facts,
      claims: [
        { entity: '林舟', action: 'waits', chapter: 12 },
        { entity: '苏棠', status: 'injured', chapter: 10 }
      ]
    });
    expect(repaired.passed).toBe(true);
  });

  it('detects invalid state transitions while preserving valid transition paths', () => {
    const fixture = readFixture<InvalidStateTransitionInput>('continuity/invalid-state-transition.json');
    const invalid = evaluateInvalidStateTransition(fixture);

    expect(invalid.passed).toBe(false);
    expect(invalid.metrics.invalidTransitionCount).toBeGreaterThan(0);
    expect(invalid.violations.map((violation) => violation.code)).toContain('transition-not-allowed');

    const valid = evaluateInvalidStateTransition({
      ...fixture,
      transitions: [
        { entity: '林舟', from: 'alive', to: 'injured', chapter: 2 },
        { entity: '林舟', from: 'injured', to: 'dead', chapter: 3 }
      ]
    });
    expect(valid.passed).toBe(true);
    expect(valid.finalStates.林舟).toBe('dead');
  });

  it('detects source-map and range failures deterministically', () => {
    type SourceMapFixture = SourceMapRangeEvaluationInput & {
      mutatedRange: SourceMapRangeAssertion;
    };
    const fixture = readFixture<SourceMapFixture>('semantic-content/source-map-range.json');
    const valid = evaluateSourceMapRanges({
      ...fixture,
      requireCoverage: false
    });
    expect(valid.passed).toBe(true);
    expect(valid.metrics.invalidSegmentCount).toBe(0);

    const invalidRange = evaluateSourceMapRanges({
      ...fixture,
      ranges: [fixture.mutatedRange]
    });
    expect(invalidRange.passed).toBe(false);
    expect(invalidRange.metrics.invalidRangeCount).toBe(1);
    expect(invalidRange.violations.map((violation) => violation.code)).toContain('range-out-of-bounds');

    const invalidSegment = evaluateSourceMapRanges({
      ...fixture,
      segments: [{ ...fixture.segments[0], editorTo: 99 }]
    });
    expect(invalidSegment.passed).toBe(false);
    expect(invalidSegment.metrics.invalidSegmentCount).toBe(1);
  });

  it('benchmarks both 100 and 300 chapter contexts within a deterministic budget', () => {
    const fixture100 = readFixture<LongContextEvaluationInput>('long-context/100-chapters.json');
    const fixture300 = readFixture<LongContextEvaluationInput>('long-context/300-chapters.json');
    const benchmark100 = createLongContextBenchmark(100, fixture100.maxTokens);
    const benchmark300 = createLongContextBenchmark(300, fixture300.maxTokens);

    const report100 = evaluateLongContextBenchmark({
      ...fixture100,
      chapters: benchmark100.chapters
    });
    const report300 = evaluateLongContextBenchmark({
      ...fixture300,
      chapters: benchmark300.chapters
    });

    expect(report100.passed).toBe(true);
    expect(report100.retainedChapterCount).toBe(100);
    expect(report100.anchorRecall).toBe(1);
    expect(report100.checkpointValid).toBe(true);
    expect(report300.passed).toBe(true);
    expect(report300.retainedChapterCount).toBe(300);
    expect(report300.anchorRecall).toBe(1);
    expect(report300.checkpointValid).toBe(true);

    const pruned = evaluateLongContextBenchmark({
      chapterCount: 300,
      maxTokens: 120,
      chapters: benchmark300.chapters,
      anchorChapters: [1, 150, 300],
      expectedAnchorRecall: 1
    });
    expect(pruned.passed).toBe(true);
    expect(pruned.metrics.prunedChapterCount).toBeGreaterThan(0);
    expect(pruned.metrics.estimatedTokens).toBeLessThanOrEqual(120);
  });

  it('detects a critical-fact mutation without flagging baseline or repair', () => {
    type MutationFixture = {
      id: string;
      baseline: EntityContradictionInput;
      mutated: EntityContradictionInput;
      repaired: EntityContradictionInput;
    };
    const fixture = readFixture<MutationFixture>('mutation/critical-facts.json');
    const input: MutationEvaluationInput<EntityContradictionInput> = {
      name: fixture.id,
      baseline: fixture.baseline,
      mutated: fixture.mutated,
      repaired: fixture.repaired,
      detect: (candidate) => !evaluateEntityContradiction(candidate).passed
    };
    const report = evaluateMutationCase(input);

    expect(report.passed).toBe(true);
    expect(report.baselineDetected).toBe(false);
    expect(report.mutationDetected).toBe(true);
    expect(report.repairedDetected).toBe(false);
  });

  it('keeps the checked-in fixture manifest valid and included by the CI workflow', () => {
    const fixtureRoot = fileURLToPath(new URL('../packages/evals/fixtures/', import.meta.url));
    const fixtureFiles = listFixtureFiles(fixtureRoot);
    expect(fixtureFiles.length).toBeGreaterThan(0);
    for (const file of fixtureFiles) {
      expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
    }

    const workflow = readFileSync(new URL('../.github/workflows/evals.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('packages/evals/**');
    expect(workflow).toContain('pnpm run test:evals');
  });
});
