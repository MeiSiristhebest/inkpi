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
    minimumCacheHitRate?: number;
    requireDistillationRecovery?: boolean;
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
  missingAnchorCount: number;
  recall: number;
  recallPercent: number;
}

export type LongContextCacheSource = 'deterministic-simulation' | 'deterministic-observation' | 'runtime-observation';

export interface LongContextCacheLookup {
  key: string;
  hit: boolean;
}

export interface LongContextCacheMetrics {
  source: LongContextCacheSource;
  lookups: number;
  hits: number;
  misses: number;
  hitRate: number;
  hitRatePercent: number;
  entryCount: number;
  invalidLookupCount: number;
}

export type LongContextDistillationSource =
  | 'deterministic-replay'
  | 'deterministic-observation'
  | 'runtime-observation';

export interface LongContextRecoveryObservation {
  attempted: boolean;
  recoveredChapter?: number;
}

export interface LongContextDistillationMetrics {
  source: LongContextDistillationSource;
  checkpointValid: boolean;
  recoveryAttempted: boolean;
  expectedNextChapter: number | undefined;
  recoveredChapter: number | undefined;
  recoveryMatchesCheckpoint: boolean;
}

export interface LongContextBenchmarkMetrics {
  chapterCount: number;
  maxTokens: number;
  pruning: LongContextPruningMetrics;
  retrieval: LongContextRetrievalMetrics;
  cache: LongContextCacheMetrics;
  distillation: LongContextDistillationMetrics;
}

export interface LongContextGateRequirements {
  expectedPruningWithinBudget?: boolean;
  minimumRetrievalRecall?: number;
  minimumCacheHitRate?: number;
  requireDistillationRecovery?: boolean;
}

export interface LongContextGateChecks {
  pruningWithinBudget: boolean;
  retrievalRecall: boolean;
  cacheHitRate: boolean;
  distillationRecovery: boolean;
}

export interface LongContextGateReport {
  passed: boolean;
  checks: LongContextGateChecks;
  violations: DeterministicViolation[];
}

export interface LongContextDeterministicBenchmarkOptions {
  /** Deterministic retained chapters supplied by a local pipeline fixture. */
  retainedChapters?: readonly number[];
  /** Deterministic cache observations; no provider or production cache is queried. */
  cacheLookups?: readonly LongContextCacheLookup[];
  /** Deterministic recovery observation; no process restart is performed. */
  recovery?: LongContextRecoveryObservation;
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
  gates: LongContextGateReport;
  metrics: LongContextBenchmarkMetrics;
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
    minimumCacheHitRate: number;
    allCacheHitRatesMeetGate: boolean;
    allDistillationRecoveriesMatch: boolean;
    allGatesPass: boolean;
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

function isValidCheckpoint(checkpoint: DistillationCheckpoint, expectedTotalChapters: number): boolean {
  return (
    Number.isInteger(checkpoint.totalChapters) &&
    checkpoint.totalChapters === expectedTotalChapters &&
    Number.isInteger(checkpoint.completedChapters) &&
    checkpoint.completedChapters >= 0 &&
    checkpoint.completedChapters < checkpoint.totalChapters &&
    Number.isInteger(checkpoint.nextChapter) &&
    checkpoint.nextChapter === checkpoint.completedChapters + 1
  );
}

/**
 * Replay only the checkpoint arithmetic. This is a deterministic fixture
 * helper, not a process-restart or production recovery measurement.
 */
export function replayDistillationCheckpoint(
  checkpoint: DistillationCheckpoint,
  expectedTotalChapters: number
): number | undefined {
  return isValidCheckpoint(checkpoint, expectedTotalChapters) ? checkpoint.completedChapters + 1 : undefined;
}

export function measureLongContextDistillationRecovery(
  checkpoint: DistillationCheckpoint,
  observation: LongContextRecoveryObservation,
  expectedTotalChapters: number,
  source: LongContextDistillationSource = 'deterministic-observation'
): LongContextDistillationMetrics {
  const checkpointValid = isValidCheckpoint(checkpoint, expectedTotalChapters);
  const expectedNextChapter = checkpointValid ? checkpoint.completedChapters + 1 : undefined;
  const recoveryAttempted = observation.attempted === true;
  const recoveredChapter = recoveryAttempted ? observation.recoveredChapter : undefined;
  return {
    source,
    checkpointValid,
    recoveryAttempted,
    expectedNextChapter,
    recoveredChapter,
    recoveryMatchesCheckpoint: checkpointValid && recoveryAttempted && recoveredChapter === expectedNextChapter
  };
}

export function measureLongContextRetrievalRecall(
  anchorChapters: readonly number[],
  retainedChapters: readonly number[],
  availableChapters?: readonly number[]
): LongContextRetrievalMetrics {
  const requested = [...new Set(anchorChapters)];
  const available = availableChapters === undefined ? undefined : new Set(availableChapters);
  const retained = new Set(retainedChapters);
  const retainedAnchorCount = requested.filter(
    (chapter) => available?.has(chapter) !== false && retained.has(chapter)
  ).length;
  const missingAnchorCount = requested.filter((chapter) => available?.has(chapter) === false).length;
  const recall = requested.length === 0 ? 1 : retainedAnchorCount / requested.length;
  return {
    requestedAnchorCount: requested.length,
    retainedAnchorCount,
    missingAnchorCount,
    recall,
    recallPercent: Math.round(recall * 100)
  };
}

export function createDeterministicCacheLookups(
  benchmarkId: string,
  retainedChapters: readonly number[],
  maxTokens: number
): LongContextCacheLookup[] {
  const contextFingerprint = stableFingerprint({ benchmarkId, retainedChapters, maxTokens });
  const retrievalFingerprint = stableFingerprint({ contextFingerprint, stage: 'retrieval' });
  return [
    { key: `context:${contextFingerprint}`, hit: false },
    { key: `context:${contextFingerprint}`, hit: true },
    { key: `retrieval:${retrievalFingerprint}`, hit: false },
    { key: `retrieval:${retrievalFingerprint}`, hit: true }
  ];
}

export function measureLongContextCache(
  lookups: readonly LongContextCacheLookup[],
  source: LongContextCacheSource = 'deterministic-observation'
): LongContextCacheMetrics {
  const entries = new Set<string>();
  let hits = 0;
  let invalidLookupCount = 0;
  for (const lookup of lookups) {
    if (typeof lookup.key !== 'string' || lookup.key.trim().length === 0 || typeof lookup.hit !== 'boolean') {
      invalidLookupCount++;
      continue;
    }
    entries.add(lookup.key);
    if (lookup.hit) hits++;
  }
  const lookupsCount = lookups.length;
  const misses = lookupsCount - hits;
  const hitRate = lookupsCount === 0 ? 0 : hits / lookupsCount;
  return {
    source,
    lookups: lookupsCount,
    hits,
    misses,
    hitRate,
    hitRatePercent: Math.round(hitRate * 100),
    entryCount: entries.size,
    invalidLookupCount
  };
}

function addGateViolation(
  violations: DeterministicViolation[],
  code: string,
  message: string,
  path: string,
  expected: unknown,
  actual: unknown
): void {
  violations.push({ code, message, path, expected, actual });
}

function validRate(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function evaluateLongContextGates(
  metrics: LongContextBenchmarkMetrics,
  requirements: LongContextGateRequirements
): LongContextGateReport {
  const violations: DeterministicViolation[] = [];
  let pruningWithinBudget = true;
  let retrievalRecall = true;
  let cacheHitRate = metrics.cache.lookups > 0 && metrics.cache.invalidLookupCount === 0;
  let distillationRecovery = true;

  if (requirements.expectedPruningWithinBudget !== undefined) {
    pruningWithinBudget = metrics.pruning.withinBudget === requirements.expectedPruningWithinBudget;
    if (!pruningWithinBudget) {
      addGateViolation(
        violations,
        'pruning-budget-expectation-mismatch',
        'Long-context pruning did not match the fixture budget expectation.',
        'metrics.pruning.withinBudget',
        requirements.expectedPruningWithinBudget,
        metrics.pruning.withinBudget
      );
    }
  }

  if (metrics.retrieval.missingAnchorCount > 0) {
    retrievalRecall = false;
    addGateViolation(
      violations,
      'retrieval-anchor-missing',
      'Retrieval anchors must be present in the long-context fixture.',
      'metrics.retrieval.missingAnchorCount',
      0,
      metrics.retrieval.missingAnchorCount
    );
  }
  if (requirements.minimumRetrievalRecall !== undefined) {
    if (!validRate(requirements.minimumRetrievalRecall)) {
      retrievalRecall = false;
      addGateViolation(
        violations,
        'retrieval-recall-threshold-invalid',
        'Retrieval recall gate thresholds must be within the inclusive 0-1 range.',
        'minimumRetrievalRecall',
        '0 <= threshold <= 1',
        requirements.minimumRetrievalRecall
      );
    } else if (metrics.retrieval.recall < requirements.minimumRetrievalRecall) {
      retrievalRecall = false;
      addGateViolation(
        violations,
        'retrieval-recall-low',
        'Retrieved anchors are below the configured recall gate.',
        'metrics.retrieval.recall',
        requirements.minimumRetrievalRecall,
        metrics.retrieval.recall
      );
    }
  }

  if (metrics.cache.invalidLookupCount > 0) {
    addGateViolation(
      violations,
      'cache-observation-invalid',
      'Cache observations require a non-empty key and a boolean hit result.',
      'metrics.cache.invalidLookupCount',
      0,
      metrics.cache.invalidLookupCount
    );
  }
  if (metrics.cache.lookups === 0) {
    addGateViolation(
      violations,
      'cache-observation-empty',
      'Cache hit gates require at least one deterministic cache lookup.',
      'metrics.cache.lookups',
      '>= 1',
      metrics.cache.lookups
    );
  }
  if (requirements.minimumCacheHitRate !== undefined) {
    if (!validRate(requirements.minimumCacheHitRate)) {
      cacheHitRate = false;
      addGateViolation(
        violations,
        'cache-hit-rate-threshold-invalid',
        'Cache hit-rate gate thresholds must be within the inclusive 0-1 range.',
        'minimumCacheHitRate',
        '0 <= threshold <= 1',
        requirements.minimumCacheHitRate
      );
    } else if (metrics.cache.hitRate < requirements.minimumCacheHitRate) {
      cacheHitRate = false;
      addGateViolation(
        violations,
        'cache-hit-rate-low',
        'Cache hit rate is below the configured deterministic gate.',
        'metrics.cache.hitRate',
        requirements.minimumCacheHitRate,
        metrics.cache.hitRate
      );
    }
  }

  if (requirements.requireDistillationRecovery) {
    distillationRecovery = metrics.distillation.recoveryMatchesCheckpoint;
    if (!distillationRecovery) {
      addGateViolation(
        violations,
        'distillation-recovery-mismatch',
        'Distillation recovery did not resume at the checkpoint next chapter.',
        'metrics.distillation.recoveredChapter',
        metrics.distillation.expectedNextChapter,
        metrics.distillation.recoveredChapter
      );
    }
  }

  const checks = { pruningWithinBudget, retrievalRecall, cacheHitRate, distillationRecovery };
  return {
    passed: violations.length === 0,
    checks,
    violations
  };
}

/**
 * Run the Phase 18 long-context contract without a provider or a model.
 * Results are deterministic fixture measurements and must not be read as
 * model quality, human preference, or production cache performance.
 */
export function runLongContextDeterministicBenchmark(
  fixture: LongContextFixtureDefinition,
  chapters = createLongContextBenchmarkChapters(fixture.chapterCount),
  options: LongContextDeterministicBenchmarkOptions = {}
): DeterministicLongContextBenchmarkReport {
  const evaluationInput = {
    chapterCount: fixture.chapterCount,
    maxTokens: fixture.maxTokens,
    chapters,
    anchorChapters: fixture.anchorChapters,
    expectedAnchorRecall: fixture.expected.anchorRecall,
    entityCount: fixture.entityCount,
    foreshadowingCount: fixture.foreshadowingCount,
    retainedChapters: options.retainedChapters,
    checkpoint: fixture.checkpoint
  };
  const preliminaryEvaluation = evaluateLongContextBenchmark(evaluationInput);
  const cacheLookups =
    options.cacheLookups ??
    createDeterministicCacheLookups(fixture.id, preliminaryEvaluation.selectedChapters, fixture.maxTokens);
  const cache = measureLongContextCache(
    cacheLookups,
    options.cacheLookups === undefined ? 'deterministic-simulation' : 'deterministic-observation'
  );
  const evaluation = evaluateLongContextBenchmark({
    ...evaluationInput,
    cacheLookups: cache.lookups,
    cacheHits: cache.hits
  });
  const sourceTokenCount = chapters.reduce((sum, chapter) => sum + estimateContextTokens(chapter.text), 0);
  const retainedTokenCount = evaluation.metrics.estimatedTokens;
  const prunedChapterCount = fixture.chapterCount - evaluation.retainedChapterCount;
  const pruning: LongContextPruningMetrics = {
    inputChapterCount: fixture.chapterCount,
    sourceTokenCount,
    retainedChapterCount: evaluation.retainedChapterCount,
    retainedTokenCount,
    prunedChapterCount,
    pruningRate: fixture.chapterCount > 0 ? prunedChapterCount / fixture.chapterCount : 0,
    withinBudget:
      Number.isInteger(fixture.maxTokens) && fixture.maxTokens > 0 && retainedTokenCount <= fixture.maxTokens
  };
  const retrieval = measureLongContextRetrievalRecall(
    fixture.anchorChapters,
    evaluation.selectedChapters,
    chapters.map((chapter) => chapter.chapter)
  );
  const recovery = options.recovery ?? {
    attempted: true,
    recoveredChapter: replayDistillationCheckpoint(fixture.checkpoint, fixture.chapterCount)
  };
  const distillation = measureLongContextDistillationRecovery(
    fixture.checkpoint,
    recovery,
    fixture.chapterCount,
    options.recovery === undefined ? 'deterministic-replay' : 'deterministic-observation'
  );
  const metrics: LongContextBenchmarkMetrics = {
    chapterCount: fixture.chapterCount,
    maxTokens: fixture.maxTokens,
    pruning,
    retrieval,
    cache,
    distillation
  };
  const gates = evaluateLongContextGates(metrics, {
    expectedPruningWithinBudget: fixture.expected.pruningWithinBudget,
    minimumRetrievalRecall: fixture.expected.anchorRecall,
    minimumCacheHitRate: fixture.expected.minimumCacheHitRate,
    requireDistillationRecovery: fixture.expected.requireDistillationRecovery ?? true
  });
  const violations = [...evaluation.violations];
  for (const violation of gates.violations) {
    if (!violations.some((existing) => existing.code === violation.code)) {
      violations.push(violation);
    }
  }
  return {
    id: fixture.id,
    mode: 'fixture-only',
    providerCalls: 0,
    modelCalls: 0,
    passed: violations.length === 0,
    violations,
    fingerprint: stableFingerprint({ id: fixture.id, metrics, gates }),
    gates,
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
      minimumCacheHitRate:
        reports.length === 0 ? 0 : Math.min(...reports.map((report) => report.metrics.cache.hitRate)),
      allCacheHitRatesMeetGate: reports.every((report) => report.gates.checks.cacheHitRate),
      allDistillationRecoveriesMatch: reports.every((report) => report.metrics.distillation.recoveryMatchesCheckpoint),
      allGatesPass: reports.every((report) => report.gates.passed)
    }
  };
}
