import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  type LongContextBenchmarkMetrics,
  type LongContextCacheLookup,
  type LongContextFixtureDefinition,
  type LongContextGateChecks,
  type LongContextRecoveryObservation,
  evaluateLongContextGates,
  measureLongContextCache,
  measureLongContextDistillationRecovery,
  measureLongContextRetrievalRecall,
  runLongContextDeterministicBenchmark
} from './benchmarks/long-context.js';
import {
  type EntityContradictionInput,
  type InvalidStateTransitionInput,
  type SourceMapRangeEvaluationInput,
  evaluateEntityContradiction,
  evaluateInvalidStateTransition,
  evaluateMutationCase,
  evaluateSourceMapRanges
} from './deterministic-evals.js';
import type { LongContextChapter } from './fixtures.js';
import {
  type HumanPairwiseValidationReport,
  type SubjectiveHumanGoldSet,
  type SubjectiveHumanPairwiseSet,
  validateSubjectiveHumanGoldSet,
  validateSubjectiveHumanPairwiseSet
} from './human-gold.js';
import {
  REAL_PROVIDER_ACCEPTANCE_MARKER,
  type RealProviderAcceptanceConfig,
  type RealProviderAcceptancePlan,
  type RealProviderName,
  type RealProviderRunResult,
  evaluateRealProviderResult,
  readRealProviderAcceptancePlan,
  reportSkippedOrInvalid
} from './real-provider-acceptance.js';
import { EvalRunner } from './runner.js';
import {
  type SubjectiveGoldSet,
  type SubjectiveRubric,
  type SubjectiveRubricReport,
  evaluateSubjectiveGoldSet,
  evaluateSubjectivePairwise,
  evaluateSubjectiveRubric
} from './subjective-evals.js';

export const PHASE18_INPUT_FILE_ENV = 'INKPI_PHASE18_INPUT_FILE';
export const PHASE18_INPUT_JSON_ENV = 'INKPI_PHASE18_INPUT_JSON';
export const PHASE18_REPORT_FILE_ENV = 'INKPI_PHASE18_REPORT_FILE';

export type Phase18GateStatus = 'skipped' | 'passed' | 'failed';

export interface Phase18GateViolation {
  code: string;
  message: string;
}

export interface Phase18RuntimeObservations {
  /** Only observations captured by the real runtime are eligible here. */
  source: 'runtime';
  runId: string;
  retainedChapters: readonly number[];
  cacheLookups: readonly LongContextCacheLookup[];
  recovery: LongContextRecoveryObservation;
}

export interface Phase18ProviderResponseContract {
  expectedRetrievedAnchors: readonly number[];
  expectedRecoveredChapter: number;
}

export const PHASE18_OBJECTIVE_KINDS = [
  'dead-character-reappearance',
  'timeline-contradiction',
  'entity-contradiction',
  'missing-payoff',
  'invalid-state-transition',
  'incorrect-retrieval',
  'range-source-map-failure'
] as const;

export type Phase18ObjectiveKind = (typeof PHASE18_OBJECTIVE_KINDS)[number];

export interface Phase18ObjectiveAssertion {
  id: string;
  kind: Phase18ObjectiveKind;
  /** A known-good candidate used to detect detector false positives. */
  baseline: unknown;
  /** The candidate whose expected result is recomputed by the gate. */
  candidate: unknown;
  expected: 'pass' | 'fail';
}

export interface Phase18MutationCase {
  id: string;
  kind: Phase18ObjectiveKind;
  /** The known-good candidate must not be detected as invalid. */
  baseline: unknown;
  /** The deliberately broken candidate must be detected as invalid. */
  mutated: unknown;
  /** The repaired candidate must not remain detected as invalid. */
  repaired: unknown;
}

export interface Phase18RealLongContextBenchmarkInput extends LongContextFixtureDefinition {
  /** A fixture-only record is never eligible for the real benchmark gate. */
  mode: 'real-provider';
  /** The chapter corpus must be supplied by the explicit input source. */
  chapters: readonly LongContextChapter[];
  observations: Phase18RuntimeObservations;
  responseContract: Phase18ProviderResponseContract;
}

export interface Phase18AcceptanceInput {
  id?: string;
  mode: 'real-provider';
  /** Binds the complete external envelope to a reproducible digest. */
  attestation: Phase18EvidenceAttestation;
  objectiveAssertions: readonly Phase18ObjectiveAssertion[];
  mutationTests: readonly Phase18MutationCase[];
  goldSet: SubjectiveHumanGoldSet;
  pairwise: SubjectiveHumanPairwiseSet;
  benchmarks: readonly Phase18RealLongContextBenchmarkInput[];
}

export interface Phase18EvidenceAttestation {
  schemaVersion: 1;
  producer: string;
  capturedAt: string;
  /** SHA-256 of the envelope after removing this attestation field. */
  inputDigest: string;
}

export interface Phase18InputValidationReport {
  passed: boolean;
  violations: Phase18GateViolation[];
  metrics: {
    hasHumanGoldSet: boolean;
    hasHumanPairwiseSet: boolean;
    objectiveAssertionCount: number;
    objectiveKinds: string[];
    mutationTestCount: number;
    mutationKinds: string[];
    rubricCaseCount: number;
    benchmarkCount: number;
    benchmarkChapterCounts: number[];
  };
}

export type Phase18InputSource = 'file' | 'environment';

export type Phase18InputPlan =
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string; violations: Phase18GateViolation[] }
  | { status: 'ready'; source: Phase18InputSource; input: Phase18AcceptanceInput };

export interface Phase18ProviderRequest {
  /** The API key is available only to the executor and is never reported. */
  config: Pick<RealProviderAcceptanceConfig, 'provider' | 'runtimeProvider' | 'model' | 'apiKey' | 'expectedMarker'>;
  prompt: string;
}

export type Phase18ProviderExecutor = (request: Phase18ProviderRequest) => Promise<RealProviderRunResult>;

export interface Phase18SubjectiveSummary {
  status: 'passed' | 'failed';
  score: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'F';
  metrics: {
    goldCaseCount: number;
    goldPassRatePercent: number;
    pairwiseComparisonCount: number;
    pairwiseAccuracyPercent: number;
    rubricCaseCount: number;
    rubricPassCount: number;
  };
}

export interface Phase18ObjectiveAssertionReport {
  id: string;
  kind: Phase18ObjectiveKind;
  expected: 'pass' | 'fail';
  baselinePassed: boolean;
  candidatePassed: boolean;
  passed: boolean;
  violations: Phase18GateViolation[];
}

export interface Phase18ObjectiveSummary {
  status: 'passed' | 'failed';
  passed: boolean;
  reports: Phase18ObjectiveAssertionReport[];
  violations: Phase18GateViolation[];
  metrics: {
    assertionCount: number;
    passedAssertionCount: number;
    coveredKindCount: number;
    requiredKindCount: number;
  };
}

export interface Phase18MutationCaseReport {
  id: string;
  kind: Phase18ObjectiveKind;
  baselineDetected: boolean;
  mutationDetected: boolean;
  repairedDetected: boolean;
  passed: boolean;
  violations: Phase18GateViolation[];
}

export interface Phase18MutationSummary {
  status: 'passed' | 'failed';
  passed: boolean;
  reports: Phase18MutationCaseReport[];
  violations: Phase18GateViolation[];
  metrics: {
    caseCount: number;
    passedCaseCount: number;
    coveredKindCount: number;
    requiredKindCount: number;
  };
}

export interface Phase18RealProviderSummary {
  status: 'passed' | 'failed';
  provider: RealProviderName;
  model: string;
  responseContainsMarker: boolean;
  structuredOutput: boolean;
  retrievedAnchorCount: number;
  recoveredChapter?: number;
  contentLength: number;
  durationMs: number;
}

export interface Phase18RealLongContextBenchmarkReport {
  id: string;
  mode: 'real-provider';
  providerCalls: 1;
  modelCalls: 1;
  passed: boolean;
  fingerprint: string;
  provider: Phase18RealProviderSummary;
  metrics: LongContextBenchmarkMetrics;
  gates: LongContextGateChecks & {
    providerResponse: boolean;
    structuredOutput: boolean;
    providerRecovery: boolean;
  };
  violations: Phase18GateViolation[];
}

export interface Phase18RealLongContextSuiteReport {
  mode: 'real-provider';
  providerCalls: number;
  modelCalls: number;
  passed: boolean;
  reports: Phase18RealLongContextBenchmarkReport[];
  metrics: {
    benchmarkCount: number;
    chapterCounts: number[];
    allGatesPass: boolean;
    allProviderResponsesPass: boolean;
    allStructuredOutputsPass: boolean;
    minimumRetrievalRecall: number;
    minimumCacheHitRate: number;
    allDistillationRecoveriesMatch: boolean;
  };
  violations: Phase18GateViolation[];
}

export interface Phase18AcceptanceReport {
  kind: 'phase18-acceptance';
  mode: 'real-provider';
  status: Phase18GateStatus;
  passed: boolean;
  timestamp: number;
  inputSource?: Phase18InputSource;
  objective?: Phase18ObjectiveSummary;
  mutation?: Phase18MutationSummary;
  provider?: {
    provider: RealProviderName;
    model: string;
  };
  subjective?: Phase18SubjectiveSummary;
  longContext?: Phase18RealLongContextSuiteReport;
  violations: Phase18GateViolation[];
}

export interface Phase18AcceptanceGateOptions {
  input?: unknown;
  providerPlan?: RealProviderAcceptancePlan;
  runProvider?: Phase18ProviderExecutor;
  inputSource?: Phase18InputSource;
  timestamp?: number;
}

export interface Phase18EnvironmentRunOptions {
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => string;
  runProvider?: Phase18ProviderExecutor;
  timestamp?: number;
}

interface ParsedProviderOutput {
  marker: string;
  retrievedAnchors: number[];
  recoveredChapter: number;
}

interface InternalViolation {
  code: string;
}

interface Phase18CandidateEvaluation {
  passed: boolean;
  violations: InternalViolation[];
}

interface Phase18TimelineEvent {
  id: string;
  at: number;
  dependsOn?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function rate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isPhase18ObjectiveKind(value: unknown): value is Phase18ObjectiveKind {
  return typeof value === 'string' && (PHASE18_OBJECTIVE_KINDS as readonly string[]).includes(value);
}

function stringArray(value: unknown, requireEntries = false): value is string[] {
  return (
    Array.isArray(value) &&
    (!requireEntries || value.length > 0) &&
    value.every((entry) => typeof entry === 'string' && entry.trim().length > 0)
  );
}

function recordArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every((entry) => isRecord(entry));
}

function optionalStringFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => value[field] === undefined || nonEmptyString(value[field]));
}

function isEntityFactShape(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  if (!optionalStringFields(value, ['entity', 'name', 'status', 'action', 'text'])) return false;
  return value.attributes === undefined || isRecord(value.attributes);
}

function isEntityContradictionShape(value: unknown): value is EntityContradictionInput {
  if (!isObjectRecord(value)) return false;
  const hasInput = ['ledger', 'facts', 'claims', 'observations', 'event'].some((field) => value[field] !== undefined);
  if (!hasInput) return false;
  if (value.ledger !== undefined) {
    if (!isObjectRecord(value.ledger)) return false;
    if (value.ledger.entities !== undefined && !recordArray(value.ledger.entities)) return false;
    if (Array.isArray(value.ledger.entities) && !value.ledger.entities.every(isEntityFactShape)) return false;
  }
  for (const field of ['facts', 'claims', 'observations'] as const) {
    if (value[field] !== undefined && (!recordArray(value[field]) || !value[field].every(isEntityFactShape)))
      return false;
  }
  if (value.event !== undefined && !isEntityFactShape(value.event)) return false;
  return value.text === undefined || typeof value.text === 'string';
}

function isStateTransitionShape(value: unknown): value is InvalidStateTransitionInput {
  if (!isObjectRecord(value) || !recordArray(value.transitions) || value.transitions.length === 0) return false;
  if (
    !value.transitions.every(
      (transition) =>
        nonEmptyString(transition.entity) &&
        nonEmptyString(transition.from) &&
        nonEmptyString(transition.to) &&
        (transition.event === undefined || nonEmptyString(transition.event)) &&
        (transition.chapter === undefined || positiveInteger(transition.chapter))
    )
  ) {
    return false;
  }
  if (value.initial !== undefined) {
    if (Array.isArray(value.initial)) {
      if (!value.initial.every((fact) => isEntityFactShape(fact))) return false;
    } else if (!isObjectRecord(value.initial) || !Object.values(value.initial).every(nonEmptyString)) {
      return false;
    }
  }
  if (value.allowedTransitions !== undefined && !isTransitionRulesShape(value.allowedTransitions)) return false;
  return value.terminalStates === undefined || isTerminalStateRulesShape(value.terminalStates);
}

function isTransitionRulesShape(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return Object.values(value).every(
    (entry) =>
      stringArray(entry) || (isObjectRecord(entry) && Object.values(entry).every((targets) => stringArray(targets)))
  );
}

function isTerminalStateRulesShape(value: unknown): boolean {
  return stringArray(value) || (isObjectRecord(value) && Object.values(value).every((states) => stringArray(states)));
}

function isSourceRangeShape(value: unknown): boolean {
  return isObjectRecord(value) && Number.isInteger(value.from) && Number.isInteger(value.to);
}

function isSourceMapAssertionShape(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  const source = value.editor ?? value.source;
  const target = value.semantic ?? value.target;
  return isSourceRangeShape(source) || isSourceRangeShape(target);
}

function isSourceMapProbeShape(value: unknown): boolean {
  if (!isObjectRecord(value)) return false;
  return ['semantic', 'editor', 'expectedEditor', 'expectedSemantic'].every(
    (field) => value[field] === undefined || Number.isInteger(value[field])
  );
}

function isSourceMapShape(value: unknown): value is SourceMapRangeEvaluationInput {
  if (!isObjectRecord(value) || !recordArray(value.segments) || value.segments.length === 0) return false;
  if (
    !value.segments.every(
      (segment) =>
        nonEmptyString(segment.blockId) &&
        Number.isInteger(segment.semanticFrom) &&
        Number.isInteger(segment.semanticTo) &&
        Number.isInteger(segment.editorFrom) &&
        Number.isInteger(segment.editorTo)
    )
  ) {
    return false;
  }
  if (value.semanticText !== undefined && typeof value.semanticText !== 'string') return false;
  if (value.editorText !== undefined && typeof value.editorText !== 'string') return false;
  for (const field of ['semanticLength', 'editorLength'] as const) {
    if (value[field] !== undefined && !nonNegativeInteger(value[field])) return false;
  }
  if (value.ranges !== undefined && (!recordArray(value.ranges) || !value.ranges.every(isSourceMapAssertionShape))) {
    return false;
  }
  if (value.probes !== undefined && (!recordArray(value.probes) || !value.probes.every(isSourceMapProbeShape))) {
    return false;
  }
  return value.requireCoverage === undefined || typeof value.requireCoverage === 'boolean';
}

function isTimelineShape(value: unknown): value is { events: Phase18TimelineEvent[] } {
  if (!isObjectRecord(value) || !recordArray(value.events) || value.events.length === 0) return false;
  return value.events.every(
    (event) =>
      nonEmptyString(event.id) &&
      finiteNumber(event.at) &&
      (event.dependsOn === undefined || nonEmptyString(event.dependsOn))
  );
}

function isMissingPayoffShape(
  value: unknown
): value is { promise: { id: string; status: string; resolveBy: number }; currentChapter: number } {
  if (!isObjectRecord(value) || !isObjectRecord(value.promise)) return false;
  return (
    nonEmptyString(value.promise.id) &&
    nonEmptyString(value.promise.status) &&
    positiveInteger(value.promise.resolveBy) &&
    positiveInteger(value.currentChapter)
  );
}

function isRetrievalShape(value: unknown): value is { expected: string[]; actual: string[]; available?: string[] } {
  if (!isObjectRecord(value) || !stringArray(value.expected, true) || !stringArray(value.actual, true)) return false;
  return value.available === undefined || stringArray(value.available);
}

function isPhase18CandidateShape(kind: Phase18ObjectiveKind, value: unknown): boolean {
  switch (kind) {
    case 'dead-character-reappearance':
    case 'entity-contradiction':
      return isEntityContradictionShape(value);
    case 'timeline-contradiction':
      return isTimelineShape(value);
    case 'missing-payoff':
      return isMissingPayoffShape(value);
    case 'invalid-state-transition':
      return isStateTransitionShape(value);
    case 'incorrect-retrieval':
      return isRetrievalShape(value);
    case 'range-source-map-failure':
      return isSourceMapShape(value);
  }
}

function evaluationFromViolations(violations: readonly { code: string }[]): Phase18CandidateEvaluation {
  return {
    passed: violations.length === 0,
    violations: violations.map(({ code }) => ({ code }))
  };
}

function evaluateTimelineCandidate(value: { events: Phase18TimelineEvent[] }): Phase18CandidateEvaluation {
  const violations: InternalViolation[] = [];
  const eventsById = new Map<string, Phase18TimelineEvent>();
  for (const event of value.events) {
    if (eventsById.has(event.id)) addViolation(violations, 'timeline-event-duplicate');
    eventsById.set(event.id, event);
  }
  for (const event of value.events) {
    if (!event.dependsOn) continue;
    const dependency = eventsById.get(event.dependsOn);
    if (!dependency) {
      addViolation(violations, 'timeline-dependency-missing');
    } else if (event.at < dependency.at) {
      addViolation(violations, 'timeline-order-contradiction');
    }
  }
  return evaluationFromViolations(violations);
}

function evaluateMissingPayoffCandidate(value: {
  promise: { id: string; status: string; resolveBy: number };
  currentChapter: number;
}): Phase18CandidateEvaluation {
  const resolvedStatuses = new Set(['resolved', 'closed', 'paid-off', 'fulfilled', '已解决', '已兑现', '已完成']);
  const status = value.promise.status.trim().toLocaleLowerCase();
  if (value.currentChapter > value.promise.resolveBy && !resolvedStatuses.has(status)) {
    return evaluationFromViolations([{ code: 'missing-payoff-overdue' }]);
  }
  return evaluationFromViolations([]);
}

function evaluateRetrievalCandidate(value: { expected: string[]; actual: string[] }): Phase18CandidateEvaluation {
  const matches =
    value.expected.length === value.actual.length &&
    value.expected.every((entry, index) => entry === value.actual[index]);
  return matches ? evaluationFromViolations([]) : evaluationFromViolations([{ code: 'retrieval-result-mismatch' }]);
}

function evaluatePhase18Candidate(kind: Phase18ObjectiveKind, value: unknown): Phase18CandidateEvaluation {
  try {
    switch (kind) {
      case 'dead-character-reappearance':
      case 'entity-contradiction':
        return evaluationFromViolations(evaluateEntityContradiction(value as EntityContradictionInput).violations);
      case 'timeline-contradiction':
        return evaluateTimelineCandidate(value as { events: Phase18TimelineEvent[] });
      case 'missing-payoff':
        return evaluateMissingPayoffCandidate(
          value as { promise: { id: string; status: string; resolveBy: number }; currentChapter: number }
        );
      case 'invalid-state-transition':
        return evaluationFromViolations(
          evaluateInvalidStateTransition(value as InvalidStateTransitionInput).violations
        );
      case 'incorrect-retrieval':
        return evaluateRetrievalCandidate(value as { expected: string[]; actual: string[] });
      case 'range-source-map-failure':
        return evaluationFromViolations(evaluateSourceMapRanges(value as SourceMapRangeEvaluationInput).violations);
    }
  } catch {
    return evaluationFromViolations([{ code: 'objective-evaluation-error' }]);
  }
}

function safeModel(value: string): string {
  return redactSecrets(value.replace(/<\/?(?:think|analysis)\b[^>]*>/gi, ''));
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(?:sk|rk|pk|xai|AIza)-[A-Za-z0-9_-]{8,}\b/g, '[secret omitted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, '$1 [secret omitted]');
}

function stripPrivateReasoning(value: string): string {
  return redactSecrets(value)
    .replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '')
    .replace(/<analysis\b[^>]*>[\s\S]*?(?:<\/analysis>|$)/gi, '')
    .trim();
}

function sensitiveFieldName(value: string): boolean {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return new Set([
    'apikey',
    'accesstoken',
    'authorization',
    'bearertoken',
    'password',
    'privatekey',
    'secret',
    'rawcot',
    'chainofthought',
    'privatereasoning',
    'reasoningtrace',
    'analysistrace'
  ]).has(normalized);
}

function containsForbiddenInputField(value: unknown, seen = new Set<object>()): boolean {
  if (!isRecord(value) && !Array.isArray(value)) return false;
  const object = value as object;
  if (seen.has(object)) return false;
  seen.add(object);
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      if (sensitiveFieldName(key) || containsForbiddenInputField(child, seen)) return true;
    }
  } else {
    for (const child of value) {
      if (containsForbiddenInputField(child, seen)) return true;
    }
  }
  return false;
}

function addViolation(violations: InternalViolation[], code: string): void {
  if (!violations.some((violation) => violation.code === code)) violations.push({ code });
}

function publicViolations(violations: readonly { code: string }[]): Phase18GateViolation[] {
  const seen = new Set<string>();
  return violations.flatMap(({ code }) => {
    if (seen.has(code)) return [];
    seen.add(code);
    return [{ code, message: 'Phase 18 evidence gate requirement was not satisfied.' }];
  });
}

function publicViolationCodes(...groups: ReadonlyArray<ReadonlyArray<{ code: string }>>): Phase18GateViolation[] {
  return publicViolations(groups.flat());
}

function validatePhase18ObjectiveAssertion(
  value: unknown,
  index: number,
  violations: InternalViolation[],
  kinds: Set<Phase18ObjectiveKind>
): void {
  if (!isObjectRecord(value)) {
    addViolation(violations, `objective-${index}-invalid`);
    return;
  }
  if (!nonEmptyString(value.id)) addViolation(violations, `objective-${index}-id-missing`);
  const kind = value.kind;
  if (!isPhase18ObjectiveKind(kind)) {
    addViolation(violations, `objective-${index}-kind-invalid`);
    return;
  }
  kinds.add(kind);
  if (value.expected !== 'pass' && value.expected !== 'fail') {
    addViolation(violations, `objective-${index}-expected-invalid`);
  }
  if (!isPhase18CandidateShape(kind, value.baseline)) {
    addViolation(violations, `objective-${index}-baseline-invalid`);
  }
  if (!isPhase18CandidateShape(kind, value.candidate)) {
    addViolation(violations, `objective-${index}-candidate-invalid`);
  }
}

function validatePhase18MutationCase(
  value: unknown,
  index: number,
  violations: InternalViolation[],
  kinds: Set<Phase18ObjectiveKind>
): void {
  if (!isObjectRecord(value)) {
    addViolation(violations, `mutation-${index}-invalid`);
    return;
  }
  if (!nonEmptyString(value.id)) addViolation(violations, `mutation-${index}-id-missing`);
  const kind = value.kind;
  if (!isPhase18ObjectiveKind(kind)) {
    addViolation(violations, `mutation-${index}-kind-invalid`);
    return;
  }
  kinds.add(kind);
  if (!isPhase18CandidateShape(kind, value.baseline)) {
    addViolation(violations, `mutation-${index}-baseline-invalid`);
  }
  if (!isPhase18CandidateShape(kind, value.mutated)) {
    addViolation(violations, `mutation-${index}-mutated-invalid`);
  }
  if (!isPhase18CandidateShape(kind, value.repaired)) {
    addViolation(violations, `mutation-${index}-repaired-invalid`);
  }
}

function addMissingObjectiveKinds(
  kinds: ReadonlySet<Phase18ObjectiveKind>,
  prefix: string,
  violations: InternalViolation[]
): void {
  for (const kind of PHASE18_OBJECTIVE_KINDS) {
    if (!kinds.has(kind)) addViolation(violations, `${prefix}-${kind}-missing`);
  }
}

export function evaluatePhase18ObjectiveAssertions(
  assertions: readonly Phase18ObjectiveAssertion[]
): Phase18ObjectiveSummary {
  const list = Array.isArray(assertions) ? assertions : [];
  const reports = list.map((assertion, index) => {
    const kind = isPhase18ObjectiveKind(assertion.kind) ? assertion.kind : PHASE18_OBJECTIVE_KINDS[0];
    const expected = assertion.expected === 'pass' ? 'pass' : 'fail';
    const baseline = evaluatePhase18Candidate(kind, assertion.baseline);
    const candidate = evaluatePhase18Candidate(kind, assertion.candidate);
    const violations: InternalViolation[] = [];
    if (!baseline.passed) addViolation(violations, `objective-${index}-baseline-false-positive`);
    if (candidate.passed !== (expected === 'pass')) addViolation(violations, `objective-${index}-outcome-mismatch`);
    return {
      id: nonEmptyString(assertion.id) ? assertion.id : `objective-${index}`,
      kind,
      expected,
      baselinePassed: baseline.passed,
      candidatePassed: candidate.passed,
      passed: baseline.passed && candidate.passed === (expected === 'pass'),
      violations: publicViolations(violations)
    } satisfies Phase18ObjectiveAssertionReport;
  });
  const coveredKinds = new Set(
    list.flatMap((assertion) => (isPhase18ObjectiveKind(assertion.kind) ? [assertion.kind] : []))
  );
  const internalViolations: InternalViolation[] = reports.flatMap((report) => report.violations);
  addMissingObjectiveKinds(coveredKinds, 'objective', internalViolations);
  const passed =
    list.length > 0 && coveredKinds.size === PHASE18_OBJECTIVE_KINDS.length && reports.every((report) => report.passed);
  return {
    status: passed ? 'passed' : 'failed',
    passed,
    reports,
    violations: publicViolations(internalViolations),
    metrics: {
      assertionCount: reports.length,
      passedAssertionCount: reports.filter((report) => report.passed).length,
      coveredKindCount: coveredKinds.size,
      requiredKindCount: PHASE18_OBJECTIVE_KINDS.length
    }
  };
}

export function evaluatePhase18MutationTests(cases: readonly Phase18MutationCase[]): Phase18MutationSummary {
  const list = Array.isArray(cases) ? cases : [];
  const reports = list.map((mutationCase, index) => {
    const kind = isPhase18ObjectiveKind(mutationCase.kind) ? mutationCase.kind : PHASE18_OBJECTIVE_KINDS[0];
    const invalidKind = !isPhase18ObjectiveKind(mutationCase.kind);
    const evaluation = evaluateMutationCase({
      name: nonEmptyString(mutationCase.id) ? mutationCase.id : `mutation-${index}`,
      baseline: mutationCase.baseline,
      mutated: mutationCase.mutated,
      repaired: mutationCase.repaired,
      detect: (candidate) => !evaluatePhase18Candidate(kind, candidate).passed
    });
    const violations: InternalViolation[] = invalidKind
      ? [{ code: `mutation-${index}-kind-invalid` }, ...evaluation.violations]
      : evaluation.violations;
    return {
      id: nonEmptyString(mutationCase.id) ? mutationCase.id : `mutation-${index}`,
      kind,
      baselineDetected: evaluation.baselineDetected,
      mutationDetected: evaluation.mutationDetected,
      repairedDetected: evaluation.repairedDetected,
      passed: !invalidKind && evaluation.passed,
      violations: publicViolations(violations)
    } satisfies Phase18MutationCaseReport;
  });
  const coveredKinds = new Set(
    list.flatMap((mutationCase) => (isPhase18ObjectiveKind(mutationCase.kind) ? [mutationCase.kind] : []))
  );
  const internalViolations: InternalViolation[] = reports.flatMap((report) => report.violations);
  addMissingObjectiveKinds(coveredKinds, 'mutation', internalViolations);
  const passed =
    list.length > 0 && coveredKinds.size === PHASE18_OBJECTIVE_KINDS.length && reports.every((report) => report.passed);
  return {
    status: passed ? 'passed' : 'failed',
    passed,
    reports,
    violations: publicViolations(internalViolations),
    metrics: {
      caseCount: reports.length,
      passedCaseCount: reports.filter((report) => report.passed).length,
      coveredKindCount: coveredKinds.size,
      requiredKindCount: PHASE18_OBJECTIVE_KINDS.length
    }
  };
}

function stableFingerprint(value: unknown): string {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

/**
 * Compute the digest that an external Phase 18 evidence assembler must put in
 * `input.attestation.inputDigest`. This catches accidental or post-capture
 * mutation of the corpus, labels, or runtime observations. The digest is an
 * integrity binding, not proof that a caller's declared human/runtime source
 * is genuine; that provenance still requires the external evidence process.
 */
export function phase18EvidenceDigest(input: unknown): string {
  const withoutAttestation = isRecord(input)
    ? Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'attestation'))
    : input;
  return stableFingerprint(withoutAttestation);
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(',')}}`;
}

function candidateRubricCases(goldSet: SubjectiveGoldSet): Array<{
  rubric: SubjectiveRubric;
  scores: Readonly<Record<string, number>> | undefined;
}> {
  return goldSet.cases.flatMap((subjectiveCase) => {
    const rubric = subjectiveCase.gold?.rubric;
    if (!rubric) return [];
    const candidate = subjectiveCase.candidate ?? {};
    return [{ rubric, scores: candidate.rubricScores ?? candidate.scores }];
  });
}

function countRubricCases(value: unknown): number {
  if (!isRecord(value) || !Array.isArray(value.cases)) return 0;
  return value.cases.filter(
    (subjectiveCase) =>
      isRecord(subjectiveCase) && isRecord(subjectiveCase.gold) && isRecord(subjectiveCase.gold.rubric)
  ).length;
}

function validateBenchmarkInput(input: unknown, index: number, violations: InternalViolation[]): number | undefined {
  if (!isRecord(input)) {
    addViolation(violations, `benchmark-${index}-invalid`);
    return undefined;
  }
  if (input.mode !== 'real-provider') addViolation(violations, `benchmark-${index}-fixture-only`);
  if (!nonEmptyString(input.id)) addViolation(violations, `benchmark-${index}-id-missing`);
  const chapterCount = input.chapterCount;
  const declaredChapterCount = typeof chapterCount === 'number' ? chapterCount : undefined;
  if (declaredChapterCount !== 100 && declaredChapterCount !== 300)
    addViolation(violations, `benchmark-${index}-chapter-count-invalid`);
  const chapters = Array.isArray(input.chapters) ? input.chapters : [];
  if (declaredChapterCount === undefined || chapters.length !== declaredChapterCount)
    addViolation(violations, `benchmark-${index}-chapter-count-mismatch`);
  const chapterNumbers = new Set<number>();
  for (const chapter of chapters) {
    if (!isRecord(chapter) || !positiveInteger(chapter.chapter) || !nonEmptyString(chapter.text)) {
      addViolation(violations, `benchmark-${index}-chapter-invalid`);
      continue;
    }
    if (chapterNumbers.has(chapter.chapter)) addViolation(violations, `benchmark-${index}-chapter-duplicate`);
    chapterNumbers.add(chapter.chapter);
  }
  if (!positiveInteger(input.maxTokens)) addViolation(violations, `benchmark-${index}-budget-invalid`);
  if (!positiveInteger(input.entityCount)) addViolation(violations, `benchmark-${index}-entity-fixture-empty`);
  if (!positiveInteger(input.foreshadowingCount))
    addViolation(violations, `benchmark-${index}-foreshadowing-fixture-empty`);

  const anchors = Array.isArray(input.anchorChapters) ? input.anchorChapters : [];
  if (anchors.length === 0 || anchors.some((chapter) => !positiveInteger(chapter) || !chapterNumbers.has(chapter))) {
    addViolation(violations, `benchmark-${index}-anchors-invalid`);
  }
  const expected = isRecord(input.expected) ? input.expected : undefined;
  if (!expected || !rate(expected.anchorRecall) || typeof expected.pruningWithinBudget !== 'boolean') {
    addViolation(violations, `benchmark-${index}-expectations-invalid`);
  }
  if (expected?.minimumCacheHitRate !== undefined && !rate(expected.minimumCacheHitRate)) {
    addViolation(violations, `benchmark-${index}-cache-threshold-invalid`);
  }

  const checkpoint = isRecord(input.checkpoint) ? input.checkpoint : undefined;
  if (
    !checkpoint ||
    checkpoint.totalChapters !== declaredChapterCount ||
    !nonNegativeInteger(checkpoint.completedChapters) ||
    checkpoint.completedChapters >= (declaredChapterCount ?? 0) ||
    checkpoint.nextChapter !== checkpoint.completedChapters + 1
  ) {
    addViolation(violations, `benchmark-${index}-checkpoint-invalid`);
  }

  const observations = isRecord(input.observations) ? input.observations : undefined;
  if (!observations || observations.source !== 'runtime' || !nonEmptyString(observations.runId)) {
    addViolation(violations, `benchmark-${index}-runtime-observations-missing`);
  }
  const retained = observations && Array.isArray(observations.retainedChapters) ? observations.retainedChapters : [];
  if (retained.length === 0 || retained.some((chapter) => !positiveInteger(chapter) || !chapterNumbers.has(chapter))) {
    addViolation(violations, `benchmark-${index}-retained-observations-invalid`);
  }
  const cacheLookups = observations && Array.isArray(observations.cacheLookups) ? observations.cacheLookups : [];
  if (
    cacheLookups.length === 0 ||
    cacheLookups.some((lookup) => !isRecord(lookup) || !nonEmptyString(lookup.key) || typeof lookup.hit !== 'boolean')
  ) {
    addViolation(violations, `benchmark-${index}-cache-observations-invalid`);
  }
  const recovery = observations?.recovery;
  if (
    !isRecord(recovery) ||
    recovery.attempted !== true ||
    !positiveInteger(recovery.recoveredChapter) ||
    !chapterNumbers.has(recovery.recoveredChapter)
  ) {
    addViolation(violations, `benchmark-${index}-recovery-observations-invalid`);
  }

  const responseContract = isRecord(input.responseContract) ? input.responseContract : undefined;
  const expectedRetrievedAnchors = responseContract?.expectedRetrievedAnchors;
  if (
    !Array.isArray(expectedRetrievedAnchors) ||
    expectedRetrievedAnchors.length === 0 ||
    expectedRetrievedAnchors.some((chapter) => !positiveInteger(chapter) || !chapterNumbers.has(chapter))
  ) {
    addViolation(violations, `benchmark-${index}-response-anchors-invalid`);
  }
  if (!responseContract || !positiveInteger(responseContract.expectedRecoveredChapter)) {
    addViolation(violations, `benchmark-${index}-response-recovery-invalid`);
  }
  return declaredChapterCount === 100 || declaredChapterCount === 300 ? declaredChapterCount : undefined;
}

/**
 * Validate the complete real-evidence envelope. No checked-in fixture is an
 * implicit input: callers must supply this object from a file or env JSON.
 */
export function validatePhase18AcceptanceInput(input: unknown): Phase18InputValidationReport {
  const violations: InternalViolation[] = [];
  const root = isRecord(input) ? input : undefined;
  if (!root) addViolation(violations, 'phase18-input-invalid');
  if (root?.mode !== 'real-provider') addViolation(violations, 'phase18-real-mode-required');
  if (root && containsForbiddenInputField(root)) addViolation(violations, 'phase18-sensitive-field-forbidden');

  const attestation = root?.attestation;
  if (!isRecord(attestation)) {
    addViolation(violations, 'phase18-attestation-missing');
  } else {
    if (attestation.schemaVersion !== 1) addViolation(violations, 'phase18-attestation-version-invalid');
    if (!nonEmptyString(attestation.producer)) addViolation(violations, 'phase18-attestation-producer-missing');
    if (!nonEmptyString(attestation.capturedAt) || Number.isNaN(Date.parse(attestation.capturedAt))) {
      addViolation(violations, 'phase18-attestation-timestamp-invalid');
    }
    if (typeof attestation.inputDigest !== 'string' || !/^[\da-f]{64}$/i.test(attestation.inputDigest)) {
      addViolation(violations, 'phase18-attestation-digest-invalid');
    } else if (attestation.inputDigest.toLowerCase() !== phase18EvidenceDigest(root)) {
      addViolation(violations, 'phase18-attestation-digest-mismatch');
    }
  }

  const objectiveAssertions = root?.objectiveAssertions;
  const objectiveList = Array.isArray(objectiveAssertions) ? objectiveAssertions : [];
  const objectiveKinds = new Set<Phase18ObjectiveKind>();
  if (objectiveList.length === 0) {
    addViolation(violations, 'objective-assertions-missing');
  } else {
    const ids = new Set<string>();
    for (const [index, assertion] of objectiveList.entries()) {
      validatePhase18ObjectiveAssertion(assertion, index, violations, objectiveKinds);
      if (isObjectRecord(assertion) && nonEmptyString(assertion.id)) {
        if (ids.has(assertion.id)) addViolation(violations, `objective-${index}-id-duplicate`);
        ids.add(assertion.id);
      }
    }
    addMissingObjectiveKinds(objectiveKinds, 'objective', violations);
  }

  const mutationTests = root?.mutationTests;
  const mutationList = Array.isArray(mutationTests) ? mutationTests : [];
  const mutationKinds = new Set<Phase18ObjectiveKind>();
  if (mutationList.length === 0) {
    addViolation(violations, 'mutation-tests-missing');
  } else {
    const ids = new Set<string>();
    for (const [index, mutationCase] of mutationList.entries()) {
      validatePhase18MutationCase(mutationCase, index, violations, mutationKinds);
      if (isObjectRecord(mutationCase) && nonEmptyString(mutationCase.id)) {
        if (ids.has(mutationCase.id)) addViolation(violations, `mutation-${index}-id-duplicate`);
        ids.add(mutationCase.id);
      }
    }
    addMissingObjectiveKinds(mutationKinds, 'mutation', violations);
  }

  const goldSet = root?.goldSet;
  const hasHumanGoldSet = isRecord(goldSet);
  if (!hasHumanGoldSet) {
    addViolation(violations, 'gold-set-missing');
  } else {
    const report = validateSubjectiveHumanGoldSet(goldSet);
    for (const violation of report.violations) addViolation(violations, violation.code);
  }

  const pairwise = root?.pairwise;
  const hasHumanPairwiseSet = isRecord(pairwise);
  if (!hasHumanPairwiseSet) {
    addViolation(violations, 'pairwise-set-missing');
  } else {
    const report = validateSubjectiveHumanPairwiseSet(pairwise);
    for (const violation of report.violations) addViolation(violations, violation.code);
  }

  const rubricCaseCount = hasHumanGoldSet ? countRubricCases(goldSet) : 0;
  if (rubricCaseCount === 0) addViolation(violations, 'rubric-data-missing');

  const benchmarks = root?.benchmarks;
  const benchmarkList = Array.isArray(benchmarks) ? benchmarks : [];
  if (benchmarkList.length !== 2) addViolation(violations, 'real-benchmark-suite-requires-100-and-300');
  const benchmarkChapterCounts = benchmarkList.map((benchmark, index) =>
    validateBenchmarkInput(benchmark, index, violations)
  );
  if (benchmarkList.length === 2) {
    const knownCounts = benchmarkChapterCounts.filter((count): count is number => count !== undefined);
    if (knownCounts.filter((count) => count === 100).length !== 1)
      addViolation(violations, 'real-100-benchmark-missing');
    if (knownCounts.filter((count) => count === 300).length !== 1)
      addViolation(violations, 'real-300-benchmark-missing');
  }

  return {
    passed: violations.length === 0,
    violations: publicViolations(violations),
    metrics: {
      hasHumanGoldSet,
      hasHumanPairwiseSet,
      objectiveAssertionCount: objectiveList.length,
      objectiveKinds: [...objectiveKinds],
      mutationTestCount: mutationList.length,
      mutationKinds: [...mutationKinds],
      rubricCaseCount,
      benchmarkCount: benchmarkList.length,
      benchmarkChapterCounts: benchmarkChapterCounts.filter((count): count is number => count !== undefined)
    }
  };
}

/** Read only the explicit Phase 18 file/env input; never falls back to fixtures. */
export function readPhase18AcceptanceInput(
  env: Record<string, string | undefined> = process.env,
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf8')
): Phase18InputPlan {
  const file = env[PHASE18_INPUT_FILE_ENV]?.trim();
  const json = env[PHASE18_INPUT_JSON_ENV]?.trim();
  if (file && json) {
    return {
      status: 'failed',
      reason: 'Set only one explicit Phase 18 input source.',
      violations: [
        { code: 'phase18-input-sources-ambiguous', message: 'Phase 18 evidence gate requirement was not satisfied.' }
      ]
    };
  }
  if (!file && !json) {
    return {
      status: 'skipped',
      reason: `Set ${PHASE18_INPUT_FILE_ENV} or ${PHASE18_INPUT_JSON_ENV} with a real-evidence envelope.`
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(file ? readFile(file) : json!);
  } catch {
    const code = file ? 'phase18-input-file-invalid' : 'phase18-input-json-invalid';
    return {
      status: 'failed',
      reason: 'The explicit Phase 18 input could not be parsed as JSON.',
      violations: [{ code, message: 'Phase 18 evidence gate requirement was not satisfied.' }]
    };
  }
  const validation = validatePhase18AcceptanceInput(raw);
  if (!validation.passed) {
    return {
      status: 'failed',
      reason: 'The explicit Phase 18 input failed evidence validation.',
      violations: validation.violations
    };
  }
  return {
    status: 'ready',
    source: file ? 'file' : 'environment',
    input: raw as Phase18AcceptanceInput
  };
}

function parseProviderOutput(content: string): ParsedProviderOutput | undefined {
  const text = stripPrivateReasoning(content);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const retrievedAnchors = parsed.retrievedAnchors;
  if (
    typeof parsed.marker !== 'string' ||
    !Array.isArray(retrievedAnchors) ||
    retrievedAnchors.some((chapter) => !positiveInteger(chapter)) ||
    !positiveInteger(parsed.recoveredChapter)
  ) {
    return undefined;
  }
  return {
    marker: parsed.marker,
    retrievedAnchors: [...retrievedAnchors],
    recoveredChapter: parsed.recoveredChapter
  };
}

function normalizeProviderResult(value: unknown): RealProviderRunResult {
  const result = isRecord(value) ? value : {};
  return {
    success: result.success === true,
    content: typeof result.content === 'string' ? result.content : '',
    durationMs: typeof result.durationMs === 'number' && Number.isFinite(result.durationMs) ? result.durationMs : 0,
    ...(isRecord(result.usage) ? { usage: result.usage } : {}),
    ...(typeof result.error === 'string' ? { error: 'provider execution failed' } : {})
  };
}

export function buildPhase18LongContextPrompt(
  input: Phase18RealLongContextBenchmarkInput,
  expectedMarker = REAL_PROVIDER_ACCEPTANCE_MARKER
): string {
  const requiredAnchors = input.responseContract.expectedRetrievedAnchors.join(', ');
  const chapters = input.chapters.map((chapter) => `CHAPTER ${chapter.chapter}\n${chapter.text}`).join('\n\n');
  return [
    'Phase 18 long-context acceptance evaluation.',
    'Return exactly one JSON object and no explanation, chain-of-thought, <think> block, or secret.',
    `The JSON marker must be exactly: ${expectedMarker}`,
    `The retrievedAnchors array must contain these chapter numbers: ${requiredAnchors}.`,
    `The recoveredChapter value must be ${input.responseContract.expectedRecoveredChapter}.`,
    'Use this schema: {"marker":"...","retrievedAnchors":[number],"recoveredChapter":number}.',
    chapters
  ].join('\n');
}

function rubricSummary(reports: readonly SubjectiveRubricReport[]): {
  score: number;
  passCount: number;
} {
  return {
    score:
      reports.length === 0
        ? 0
        : Math.round(reports.reduce((total, report) => total + report.score, 0) / reports.length),
    passCount: reports.filter((report) => report.passed).length
  };
}

function evaluateSubjectiveEvidence(input: Phase18AcceptanceInput): {
  summary: Phase18SubjectiveSummary;
  violations: Phase18GateViolation[];
} {
  const goldValidation = validateSubjectiveHumanGoldSet(input.goldSet);
  const pairwiseValidation: HumanPairwiseValidationReport = validateSubjectiveHumanPairwiseSet(input.pairwise);
  const goldReport = evaluateSubjectiveGoldSet(input.goldSet);
  const pairwiseReport = evaluateSubjectivePairwise({
    ...input.pairwise,
    requireExplicitObservedPreference: true
  });
  const rubricReports = candidateRubricCases(input.goldSet).map(({ rubric, scores }) =>
    evaluateSubjectiveRubric({ rubric, scores })
  );
  const rubric = rubricSummary(rubricReports);
  const runner = new EvalRunner([
    {
      id: 'human-gold-set',
      weight: 1,
      evaluate: () => ({ score: goldReport.score, passed: goldValidation.passed && goldReport.passed })
    },
    {
      id: 'pairwise-preference',
      weight: 1,
      evaluate: () => ({ score: pairwiseReport.score, passed: pairwiseValidation.passed && pairwiseReport.passed })
    },
    {
      id: 'rubric-scoring',
      weight: 1,
      evaluate: () => ({
        score: rubric.score,
        passed: rubricReports.length > 0 && rubric.passCount === rubricReports.length
      })
    }
  ]);
  const aggregate = runner.evaluate({
    title: 'Phase 18 subjective evidence',
    sectionTitle: 'human-labelled',
    content: '[evaluation input omitted]'
  });
  const violations: InternalViolation[] = [];
  for (const violation of goldValidation.violations) addViolation(violations, violation.code);
  for (const violation of pairwiseValidation.violations) addViolation(violations, violation.code);
  for (const violation of goldReport.violations) addViolation(violations, violation.code);
  for (const violation of pairwiseReport.violations) addViolation(violations, violation.code);
  for (const report of rubricReports) {
    for (const violation of report.violations) addViolation(violations, violation.code);
  }
  if (!aggregate.passed) addViolation(violations, 'subjective-eval-aggregate-failed');
  return {
    summary: {
      status: violations.length === 0 ? 'passed' : 'failed',
      score: aggregate.overallScore,
      grade: aggregate.grade,
      metrics: {
        goldCaseCount: goldReport.metrics.caseCount,
        goldPassRatePercent: goldReport.metrics.passRatePercent,
        pairwiseComparisonCount: pairwiseReport.metrics.comparisonCount,
        pairwiseAccuracyPercent: pairwiseReport.metrics.accuracyPercent,
        rubricCaseCount: rubricReports.length,
        rubricPassCount: rubric.passCount
      }
    },
    violations: publicViolations(violations)
  };
}

function makeRealBenchmarkBase(input: Phase18RealLongContextBenchmarkInput): LongContextFixtureDefinition {
  return {
    id: input.id,
    chapterCount: input.chapterCount,
    maxTokens: input.maxTokens,
    anchorChapters: input.anchorChapters,
    entityCount: input.entityCount,
    foreshadowingCount: input.foreshadowingCount,
    checkpoint: input.checkpoint,
    expected: input.expected
  };
}

export async function runPhase18RealLongContextBenchmark(
  input: Phase18RealLongContextBenchmarkInput,
  config: Pick<RealProviderAcceptanceConfig, 'provider' | 'runtimeProvider' | 'model' | 'apiKey' | 'expectedMarker'>,
  runProvider: Phase18ProviderExecutor,
  timestamp = Date.now()
): Promise<Phase18RealLongContextBenchmarkReport> {
  const startTime = Date.now();
  let result: RealProviderRunResult;
  try {
    result = normalizeProviderResult(
      await runProvider({
        config,
        prompt: buildPhase18LongContextPrompt(input, config.expectedMarker)
      })
    );
  } catch {
    result = { success: false, content: '', durationMs: Date.now() - startTime, error: 'provider execution failed' };
  }
  const providerHealth = evaluateRealProviderResult(
    { provider: config.provider, model: config.model, expectedMarker: config.expectedMarker },
    result,
    timestamp
  );
  const parsed = parseProviderOutput(result.content);
  const structural = runLongContextDeterministicBenchmark(makeRealBenchmarkBase(input), [...input.chapters], {
    retainedChapters: input.observations.retainedChapters,
    cacheLookups: input.observations.cacheLookups,
    recovery: input.observations.recovery
  });
  const retrieval = measureLongContextRetrievalRecall(
    input.responseContract.expectedRetrievedAnchors,
    parsed?.retrievedAnchors ?? [],
    input.chapters.map((chapter) => chapter.chapter)
  );
  const cache = measureLongContextCache(input.observations.cacheLookups, 'runtime-observation');
  const distillation = measureLongContextDistillationRecovery(
    input.checkpoint,
    input.observations.recovery,
    input.chapterCount,
    'runtime-observation'
  );
  const metrics: LongContextBenchmarkMetrics = {
    ...structural.metrics,
    retrieval,
    cache,
    distillation
  };
  const structuralGates = evaluateLongContextGates(metrics, {
    expectedPruningWithinBudget: input.expected.pruningWithinBudget,
    minimumRetrievalRecall: input.expected.anchorRecall,
    minimumCacheHitRate: input.expected.minimumCacheHitRate,
    requireDistillationRecovery: input.expected.requireDistillationRecovery ?? true
  });
  const structuredOutput = parsed !== undefined;
  const providerRecovery = parsed?.recoveredChapter === input.responseContract.expectedRecoveredChapter;
  const providerResponse = providerHealth.passed;
  const gates = {
    ...structuralGates.checks,
    providerResponse,
    structuredOutput,
    providerRecovery
  };
  const internalViolations: InternalViolation[] = [];
  for (const violation of structural.violations) addViolation(internalViolations, violation.code);
  for (const violation of structuralGates.violations) addViolation(internalViolations, violation.code);
  if (!providerResponse) addViolation(internalViolations, 'real-provider-response-invalid');
  if (!structuredOutput) addViolation(internalViolations, 'real-provider-structured-output-invalid');
  if (structuredOutput && !providerRecovery) addViolation(internalViolations, 'real-provider-recovery-mismatch');
  const passed =
    providerResponse &&
    structuredOutput &&
    providerRecovery &&
    structural.violations.length === 0 &&
    structuralGates.passed;
  const providerSummary: Phase18RealProviderSummary = {
    status: passed ? 'passed' : 'failed',
    provider: config.provider,
    model: safeModel(config.model),
    responseContainsMarker: providerHealth.responseContainsMarker === true,
    structuredOutput,
    retrievedAnchorCount: parsed?.retrievedAnchors.length ?? 0,
    ...(parsed ? { recoveredChapter: parsed.recoveredChapter } : {}),
    contentLength: result.content.trim().length,
    durationMs: result.durationMs
  };
  return {
    id: input.id,
    mode: 'real-provider',
    providerCalls: 1,
    modelCalls: 1,
    passed,
    fingerprint: stableFingerprint({ id: input.id, metrics, gates, passed }),
    provider: providerSummary,
    metrics,
    gates,
    violations: publicViolations(internalViolations)
  };
}

export async function runPhase18RealLongContextBenchmarkSuite(
  inputs: readonly Phase18RealLongContextBenchmarkInput[],
  config: Pick<RealProviderAcceptanceConfig, 'provider' | 'runtimeProvider' | 'model' | 'apiKey' | 'expectedMarker'>,
  runProvider: Phase18ProviderExecutor,
  timestamp = Date.now()
): Promise<Phase18RealLongContextSuiteReport> {
  const reports: Phase18RealLongContextBenchmarkReport[] = [];
  for (const input of inputs) {
    reports.push(await runPhase18RealLongContextBenchmark(input, config, runProvider, timestamp));
  }
  const violations = reports.flatMap((report) => report.violations);
  return {
    mode: 'real-provider',
    providerCalls: reports.length,
    modelCalls: reports.length,
    passed: reports.length === 2 && reports.every((report) => report.passed),
    reports,
    metrics: {
      benchmarkCount: reports.length,
      chapterCounts: reports.map((report) => report.metrics.chapterCount),
      allGatesPass: reports.length > 0 && reports.every((report) => reportsGatesPass(report)),
      allProviderResponsesPass: reports.length > 0 && reports.every((report) => report.gates.providerResponse),
      allStructuredOutputsPass: reports.length > 0 && reports.every((report) => report.gates.structuredOutput),
      minimumRetrievalRecall:
        reports.length === 0 ? 0 : Math.min(...reports.map((report) => report.metrics.retrieval.recall)),
      minimumCacheHitRate:
        reports.length === 0 ? 0 : Math.min(...reports.map((report) => report.metrics.cache.hitRate)),
      allDistillationRecoveriesMatch:
        reports.length > 0 && reports.every((report) => report.metrics.distillation.recoveryMatchesCheckpoint)
    },
    violations: publicViolations(violations)
  };
}

function reportsGatesPass(report: Phase18RealLongContextBenchmarkReport): boolean {
  return Object.values(report.gates).every((value) => value === true);
}

function skippedReport(
  status: 'skipped' | 'failed',
  timestamp: number,
  reasonCode: string,
  reason?: string,
  inputSource?: Phase18InputSource
): Phase18AcceptanceReport {
  return {
    kind: 'phase18-acceptance',
    mode: 'real-provider',
    status,
    passed: false,
    timestamp,
    ...(inputSource ? { inputSource } : {}),
    violations: [{ code: reasonCode, message: reason ?? 'Phase 18 evidence gate requirement was not satisfied.' }]
  };
}

export async function runPhase18AcceptanceGate(
  options: Phase18AcceptanceGateOptions = {}
): Promise<Phase18AcceptanceReport> {
  const timestamp = options.timestamp ?? Date.now();
  if (options.input === undefined) {
    return skippedReport('skipped', timestamp, 'phase18-input-missing', 'Set an explicit Phase 18 input source.');
  }
  const validation = validatePhase18AcceptanceInput(options.input);
  if (!validation.passed) {
    return {
      ...skippedReport('failed', timestamp, 'phase18-input-invalid', undefined, options.inputSource),
      violations: validation.violations
    };
  }
  const input = options.input as Phase18AcceptanceInput;
  const objective = evaluatePhase18ObjectiveAssertions(input.objectiveAssertions);
  const mutation = evaluatePhase18MutationTests(input.mutationTests);
  if (!objective.passed || !mutation.passed) {
    return {
      kind: 'phase18-acceptance',
      mode: 'real-provider',
      status: 'failed',
      passed: false,
      timestamp,
      ...(options.inputSource ? { inputSource: options.inputSource } : {}),
      objective,
      mutation,
      violations: publicViolationCodes(objective.violations, mutation.violations)
    };
  }
  const plan = options.providerPlan ?? readRealProviderAcceptancePlan();
  if (plan.status !== 'ready') {
    const providerReport = reportSkippedOrInvalid(plan, timestamp);
    const status: 'skipped' | 'failed' = providerReport.status === 'skipped' ? 'skipped' : 'failed';
    return skippedReport(
      status,
      timestamp,
      status === 'skipped' ? 'real-provider-missing' : 'real-provider-config-invalid',
      status === 'skipped' ? 'An explicit real provider is required.' : 'The real provider configuration is invalid.',
      options.inputSource
    );
  }
  if (!options.runProvider) {
    return skippedReport('failed', timestamp, 'real-provider-executor-missing', undefined, options.inputSource);
  }

  const subjective = evaluateSubjectiveEvidence(input);
  if (subjective.summary.status !== 'passed') {
    return {
      kind: 'phase18-acceptance',
      mode: 'real-provider',
      status: 'failed',
      passed: false,
      timestamp,
      ...(options.inputSource ? { inputSource: options.inputSource } : {}),
      objective,
      mutation,
      provider: { provider: plan.config.provider, model: safeModel(plan.config.model) },
      subjective: subjective.summary,
      violations: subjective.violations
    };
  }

  const suite = await runPhase18RealLongContextBenchmarkSuite(
    input.benchmarks,
    plan.config,
    options.runProvider,
    timestamp
  );
  const passed = subjective.summary.status === 'passed' && suite.passed;
  return {
    kind: 'phase18-acceptance',
    mode: 'real-provider',
    status: passed ? 'passed' : 'failed',
    passed,
    timestamp,
    ...(options.inputSource ? { inputSource: options.inputSource } : {}),
    objective,
    mutation,
    provider: { provider: plan.config.provider, model: safeModel(plan.config.model) },
    subjective: subjective.summary,
    longContext: suite,
    violations: publicViolationCodes(subjective.violations, suite.violations)
  };
}

export async function runPhase18AcceptanceFromEnvironment(
  options: Phase18EnvironmentRunOptions = {}
): Promise<Phase18AcceptanceReport> {
  const env = options.env ?? process.env;
  const inputPlan = readPhase18AcceptanceInput(env, options.readFile);
  const timestamp = options.timestamp ?? Date.now();
  if (inputPlan.status === 'skipped') {
    return skippedReport('skipped', timestamp, 'phase18-input-missing', inputPlan.reason);
  }
  if (inputPlan.status === 'failed') {
    return {
      ...skippedReport('failed', timestamp, 'phase18-input-invalid'),
      violations: inputPlan.violations
    };
  }
  return runPhase18AcceptanceGate({
    input: inputPlan.input,
    inputSource: inputPlan.source,
    providerPlan: readRealProviderAcceptancePlan(env),
    runProvider: options.runProvider,
    timestamp
  });
}

/** Defensive last-mile sanitization for reports written by executable gates. */
export function sanitizePhase18Report(report: Phase18AcceptanceReport): Phase18AcceptanceReport {
  const sanitize = (value: unknown, key?: string): unknown => {
    if (key && sensitiveFieldName(key)) return '[redacted]';
    if (typeof value === 'string') return stripPrivateReasoning(value);
    if (Array.isArray(value)) return value.map((item) => sanitize(item));
    if (isRecord(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([childKey, child]) => [childKey, sanitize(child, childKey)])
      );
    }
    return value;
  };
  return sanitize(report) as Phase18AcceptanceReport;
}
