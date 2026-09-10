import { createHash } from 'node:crypto';
import {
  type DeterministicViolation,
  estimateContextTokens,
  evaluateLongContextBenchmark
} from '../deterministic-evals.js';
import type { LongContextChapter } from '../fixtures.js';

/**
 * The long-context fixtures describe metric expectations, not model outputs.
 * This type intentionally keeps that distinction visible to callers.
 */
export interface LongContextFixtureDefinition {
  id: string;
  chapterCount: number;
  maxTokens: number;
  anchorChapters: readonly number[];
  entityCount: number;
  foreshadowingCount: number;
  checkpoint: DistillationCheckpoint;
  expected: {
    anchorRecall: number;
    pruningWithinBudget: boolean;
  };
}

export interface DistillationCheckpoint {
  totalChapters: number;
  completedChapters: number;
  nextChapter: number;
}

export interface LongContextPruningMetrics {
  inputChapterCount: number;
  sourceTokenCount: number;
  retainedChapterCount: number;
  retainedTokenCount: number;
  prunedChapterCount: number;
  pruningRate: number;
  withinBudget: boolean;
}

export interface LongContextRetrievalMetrics {
  requestedAnchorCount: number;
  retainedAnchorCount: number;
  recall: number;
  recallPercent: number;
}

export interface LongContextCacheMetrics {
  source: 'deterministic-simulation';
  lookups: number;
  hits: number;
  misses: number;
  hitRate: number;
  hitRatePercent: number;
  entryCount: number;
}

export interface LongContextDistillationMetrics {
  checkpointValid: boolean;
  recoveryAttempted: boolean;
  recoveredChapter: number | undefined;
  recoveryMatchesCheckpoint: boolean;
}

export interface DeterministicLongContextBenchmarkReport {
  id: string;
  mode: 'fixture-only';
  /** Always zero: this benchmark never invokes a provider or a model. */
  providerCalls: 0;
  /** Always zero: this benchmark never invokes a provider or a model. */
  modelCalls: 0;
  passed: boolean;
  violations: DeterministicViolation[];
  fingerprint: string;
  metrics: {
    chapterCount: number;
    maxTokens: number;
    pruning: LongContextPruningMetrics;
    retrieval: LongContextRetrievalMetrics;
    cache: LongContextCacheMetrics;
    distillation: LongContextDistillationMetrics;
  };
}

export interface LongContextBenchmarkSuiteReport {
  mode: 'fixture-only';
  providerCalls: 0;
  modelCalls: 0;
  passed: boolean;
  reports: DeterministicLongContextBenchmarkReport[];
  metrics: {
    benchmarkCount: number;
    chapterCounts: number[];
    allPruningWithinBudget: boolean;
    minimumRetrievalRecall: number;
    averageCacheHitRate: number;
    allDistillationRecoveriesMatch: boolean;
  };
}

/**
 * Produce a sizeable but bounded deterministic chapter corpus. The repeated
 * payload makes both 100- and 300-chapter runs exercise pruning without
 * requiring a network, credentials, or a model.
 */
export function createLongContextBenchmarkChapters(chapterCount: number): LongContextChapter[] {
  return Array.from({ length: Math.max(0, Math.floor(chapterCount)) }, (_, index) => {
    const chapter = index + 1;
    const entity = `entity-${((chapter - 1) % 17) + 1}`;
    const foreshadowing = `foreshadowing-${((chapter - 1) % 23) + 1}`;
    return {
      chapter,
      text: `chapter-${chapter}: ${entity} records ${foreshadowing}; ${'stable context evidence is retained for deterministic long-context evaluation. '.repeat(4)}`
    };
  });
}

function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function recoveredChapterFromCheckpoint(checkpoint: DistillationCheckpoint): number | undefined {
  const restored = JSON.parse(JSON.stringify(checkpoint)) as DistillationCheckpoint;
  if (
    !Number.isInteger(restored.totalChapters) ||
    restored.totalChapters < 1 ||
    !Number.isInteger(restored.completedChapters) ||
    restored.completedChapters < 0 ||
    restored.completedChapters >= restored.totalChapters ||
    restored.nextChapter !== restored.completedChapters + 1
  ) {
    return undefined;
  }
  return restored.nextChapter;
}

function measureCache(
  benchmarkId: string,
  retainedChapters: readonly number[],
  maxTokens: number
): LongContextCacheMetrics {
  const cache = new Map<string, string>();
  const contextFingerprint = stableFingerprint({ benchmarkId, retainedChapters, maxTokens });
  const requests = [
    { stage: 'context', fingerprint: contextFingerprint },
    { stage: 'context', fingerprint: contextFingerprint },
    { stage: 'retrieval', fingerprint: stableFingerprint({ contextFingerprint, stage: 'retrieval' }) },
    { stage: 'retrieval', fingerprint: stableFingerprint({ contextFingerprint, stage: 'retrieval' }) }
  ];
  let hits = 0;
  for (const request of requests) {
    const key = `${request.stage}:${request.fingerprint}`;
    if (cache.has(key)) {
      hits++;
      continue;
    }
    cache.set(key, request.fingerprint);
  }
  const lookups = requests.length;
  const misses = lookups - hits;
  return {
    source: 'deterministic-simulation',
    lookups,
    hits,
    misses,
    hitRate: hits / lookups,
    hitRatePercent: Math.round((hits / lookups) * 100),
    entryCount: cache.size
  };
}

function addViolation(
  violations: DeterministicViolation[],
  code: string,
  message: string,
  path: string,
  expected: unknown,
  actual: unknown
): void {
  violations.push({ code, message, path, expected, actual });
}

/**
 * Run the Phase 18 long-context contract without a provider or a model.
 * Results are deterministic fixture measurements and must not be read as
 * model quality, human preference, or production cache performance.
 */
export function runLongContextDeterministicBenchmark(
  fixture: LongContextFixtureDefinition,
  chapters = createLongContextBenchmarkChapters(fixture.chapterCount)
): DeterministicLongContextBenchmarkReport {
  const evaluation = evaluateLongContextBenchmark({
    chapterCount: fixture.chapterCount,
    maxTokens: fixture.maxTokens,
    chapters,
    anchorChapters: fixture.anchorChapters,
    expectedAnchorRecall: fixture.expected.anchorRecall,
    entityCount: fixture.entityCount,
    foreshadowingCount: fixture.foreshadowingCount,
    cacheLookups: 4,
    cacheHits: 2,
    checkpoint: fixture.checkpoint
  });
  const sourceTokenCount = chapters.reduce((sum, chapter) => sum + estimateContextTokens(chapter.text), 0);
  const retainedTokenCount = evaluation.metrics.estimatedTokens;
  const pruning: LongContextPruningMetrics = {
    inputChapterCount: fixture.chapterCount,
    sourceTokenCount,
    retainedChapterCount: evaluation.retainedChapterCount,
    retainedTokenCount,
    prunedChapterCount: fixture.chapterCount - evaluation.retainedChapterCount,
    pruningRate: (fixture.chapterCount - evaluation.retainedChapterCount) / fixture.chapterCount,
    withinBudget: retainedTokenCount <= fixture.maxTokens
  };
  const retainedAnchorCount = fixture.anchorChapters.filter((chapter) =>
    evaluation.selectedChapters.includes(chapter)
  ).length;
  const retrieval: LongContextRetrievalMetrics = {
    requestedAnchorCount: fixture.anchorChapters.length,
    retainedAnchorCount,
    recall: fixture.anchorChapters.length === 0 ? 1 : retainedAnchorCount / fixture.anchorChapters.length,
    recallPercent:
      fixture.anchorChapters.length === 0
        ? 100
        : Math.round((retainedAnchorCount / fixture.anchorChapters.length) * 100)
  };
  const cache = measureCache(fixture.id, evaluation.selectedChapters, fixture.maxTokens);
  const recoveredChapter = recoveredChapterFromCheckpoint(fixture.checkpoint);
  const distillation: LongContextDistillationMetrics = {
    checkpointValid: evaluation.checkpointValid === true,
    recoveryAttempted: true,
    recoveredChapter,
    recoveryMatchesCheckpoint: recoveredChapter === fixture.checkpoint.nextChapter
  };
  const violations = [...evaluation.violations];
  if (pruning.withinBudget !== fixture.expected.pruningWithinBudget) {
    addViolation(
      violations,
      'pruning-budget-expectation-mismatch',
      'Long-context pruning did not match the fixture budget expectation.',
      'metrics.pruning.withinBudget',
      fixture.expected.pruningWithinBudget,
      pruning.withinBudget
    );
  }
  if (!distillation.recoveryMatchesCheckpoint) {
    addViolation(
      violations,
      'distillation-recovery-mismatch',
      'Distillation recovery did not resume at the checkpoint next chapter.',
      'metrics.distillation.recoveredChapter',
      fixture.checkpoint.nextChapter,
      recoveredChapter
    );
  }
  const metrics = {
    chapterCount: fixture.chapterCount,
    maxTokens: fixture.maxTokens,
    pruning,
    retrieval,
    cache,
    distillation
  };
  return {
    id: fixture.id,
    mode: 'fixture-only',
    providerCalls: 0,
    modelCalls: 0,
    passed: violations.length === 0,
    violations,
    fingerprint: stableFingerprint({ id: fixture.id, metrics }),
    metrics
  };
}

export function runLongContextDeterministicBenchmarkSuite(
  fixtures: readonly LongContextFixtureDefinition[]
): LongContextBenchmarkSuiteReport {
  const reports = fixtures.map((fixture) => runLongContextDeterministicBenchmark(fixture));
  return {
    mode: 'fixture-only',
    providerCalls: 0,
    modelCalls: 0,
    passed: reports.every((report) => report.passed),
    reports,
    metrics: {
      benchmarkCount: reports.length,
      chapterCounts: reports.map((report) => report.metrics.chapterCount),
      allPruningWithinBudget: reports.every((report) => report.metrics.pruning.withinBudget),
      minimumRetrievalRecall:
        reports.length === 0 ? 1 : Math.min(...reports.map((report) => report.metrics.retrieval.recall)),
      averageCacheHitRate:
        reports.length === 0
          ? 0
          : reports.reduce((sum, report) => sum + report.metrics.cache.hitRate, 0) / reports.length,
      allDistillationRecoveriesMatch: reports.every((report) => report.metrics.distillation.recoveryMatchesCheckpoint)
    }
  };
}
