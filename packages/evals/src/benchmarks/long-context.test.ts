import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type LongContextFixtureDefinition,
  createLongContextBenchmarkChapters,
  measureLongContextCache,
  measureLongContextRetrievalRecall,
  runLongContextDeterministicBenchmark,
  runLongContextDeterministicBenchmarkSuite
} from './long-context.js';

function readFixture(name: string): LongContextFixtureDefinition {
  return JSON.parse(
    readFileSync(new URL(`../../fixtures/long-context/${name}`, import.meta.url), 'utf8')
  ) as LongContextFixtureDefinition;
}

const fixtures = ['100-chapters.json', '300-chapters.json'].map(readFixture);

describe('Phase 18 deterministic long-context benchmarks', () => {
  it.each(fixtures)('measures pruning, retrieval, cache, and recovery for $chapterCount chapters', (fixture) => {
    const report = runLongContextDeterministicBenchmark(fixture);

    expect(report.passed).toBe(true);
    expect(report.mode).toBe('fixture-only');
    expect(report.providerCalls).toBe(0);
    expect(report.modelCalls).toBe(0);
    expect(report.metrics.pruning).toMatchObject({
      inputChapterCount: fixture.chapterCount,
      retainedTokenCount: expect.any(Number),
      withinBudget: true
    });
    expect(report.metrics.pruning.prunedChapterCount).toBeGreaterThan(0);
    expect(report.metrics.pruning.pruningRate).toBeGreaterThan(0);
    expect(report.metrics.retrieval).toMatchObject({
      requestedAnchorCount: fixture.anchorChapters.length,
      retainedAnchorCount: fixture.anchorChapters.length,
      recall: fixture.expected.anchorRecall,
      recallPercent: 100
    });
    expect(report.metrics.cache).toMatchObject({
      source: 'deterministic-simulation',
      lookups: 4,
      hits: 2,
      misses: 2,
      hitRate: 0.5,
      hitRatePercent: 50,
      entryCount: 2,
      invalidLookupCount: 0
    });
    expect(report.metrics.distillation).toMatchObject({
      checkpointValid: true,
      recoveryAttempted: true,
      recoveredChapter: fixture.checkpoint.nextChapter,
      recoveryMatchesCheckpoint: true
    });
    expect(report.gates).toMatchObject({
      passed: true,
      checks: {
        pruningWithinBudget: true,
        retrievalRecall: true,
        cacheHitRate: true,
        distillationRecovery: true
      }
    });
  });

  it('keeps the 100/300 chapter suite deterministic and fixture-only', () => {
    const first = runLongContextDeterministicBenchmarkSuite(fixtures);
    const second = runLongContextDeterministicBenchmarkSuite(structuredClone(fixtures));

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      mode: 'fixture-only',
      providerCalls: 0,
      modelCalls: 0,
      passed: true,
      metrics: {
        benchmarkCount: 2,
        chapterCounts: [100, 300],
        allPruningWithinBudget: true,
        minimumRetrievalRecall: 1,
        averageCacheHitRate: 0.5,
        minimumCacheHitRate: 0.5,
        allCacheHitRatesMeetGate: true,
        allDistillationRecoveriesMatch: true,
        allGatesPass: true
      }
    });
    expect(first.reports.map((report) => report.fingerprint)).toEqual(
      second.reports.map((report) => report.fingerprint)
    );
  });

  it('detects a broken checkpoint and does not treat it as a successful recovery', () => {
    const fixture = structuredClone(fixtures[1]);
    fixture.checkpoint.nextChapter = fixture.checkpoint.completedChapters;

    const report = runLongContextDeterministicBenchmark(fixture);

    expect(report.passed).toBe(false);
    expect(report.metrics.distillation).toMatchObject({
      checkpointValid: false,
      recoveryAttempted: true,
      recoveredChapter: undefined,
      recoveryMatchesCheckpoint: false
    });
    expect(report.gates.checks.distillationRecovery).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toContain('distillation-checkpoint-invalid');
  });

  it('detects retrieval loss when the deterministic budget cannot retain anchors', () => {
    const fixture = { ...structuredClone(fixtures[0]), maxTokens: 1 };
    const report = runLongContextDeterministicBenchmark(fixture, createLongContextBenchmarkChapters(100));

    expect(report.passed).toBe(false);
    expect(report.metrics.retrieval.recall).toBe(0);
    expect(report.gates.checks.retrievalRecall).toBe(false);
    expect(report.violations.map((violation) => violation.code)).toContain('retrieval-recall-low');
  });

  it('calculates recall from unique anchors and accepts only deterministic cache observations', () => {
    expect(measureLongContextRetrievalRecall([1, 1, 2], [2], [1, 2, 3])).toMatchObject({
      requestedAnchorCount: 2,
      retainedAnchorCount: 1,
      missingAnchorCount: 0,
      recall: 0.5,
      recallPercent: 50
    });
    expect(measureLongContextRetrievalRecall([1, 9], [1], [1, 2])).toMatchObject({
      requestedAnchorCount: 2,
      retainedAnchorCount: 1,
      missingAnchorCount: 1,
      recall: 0.5
    });

    expect(
      measureLongContextCache(
        [
          { key: 'context:a', hit: false },
          { key: 'context:a', hit: true },
          { key: 'retrieval:b', hit: false }
        ],
        'deterministic-observation'
      )
    ).toMatchObject({
      source: 'deterministic-observation',
      lookups: 3,
      hits: 1,
      misses: 2,
      hitRate: 1 / 3,
      entryCount: 2,
      invalidLookupCount: 0
    });
  });

  it('gates injected cache and recovery observations without invoking a provider', () => {
    const fixture = structuredClone(fixtures[0]);
    const report = runLongContextDeterministicBenchmark(
      fixture,
      createLongContextBenchmarkChapters(fixture.chapterCount),
      {
        cacheLookups: [
          { key: 'context:a', hit: false },
          { key: 'context:b', hit: false }
        ],
        recovery: {
          attempted: true,
          recoveredChapter: fixture.checkpoint.nextChapter - 1
        }
      }
    );

    expect(report.mode).toBe('fixture-only');
    expect(report.providerCalls).toBe(0);
    expect(report.modelCalls).toBe(0);
    expect(report.passed).toBe(false);
    expect(report.metrics.cache.source).toBe('deterministic-observation');
    expect(report.metrics.cache.hitRate).toBe(0);
    expect(report.metrics.distillation.recoveryMatchesCheckpoint).toBe(false);
    expect(report.gates.checks).toMatchObject({ cacheHitRate: false, distillationRecovery: false });
    expect(report.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(['cache-hit-rate-low', 'distillation-recovery-mismatch'])
    );
  });
});
