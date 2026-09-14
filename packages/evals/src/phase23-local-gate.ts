/**
 * Local, deterministic coverage gate for the twenty atomic conditions in the
 * original Phase 23 plan.
 *
 * This is deliberately separate from the external Phase 18/23 evidence
 * assembler. Local tests and fixtures can prove regression coverage, but they
 * must never be promoted to real-provider, human-labelled, GUI, or production
 * evidence by this module.
 */

export const PHASE23_LOCAL_GATE_SCHEMA_VERSION = 1 as const;

export type Phase23AtomicConditionId =
  | 'canonical-content'
  | 'canonical-story-model'
  | 'continue-prose'
  | 'selection-rewrite'
  | 'continuity-audit'
  | 'deep-story-reasoning'
  | 'project-distillation'
  | 'projection-sync'
  | 'proposal-commit'
  | 'optimistic-concurrency'
  | 'durable-execution'
  | 'context-pipeline'
  | 'story-context-compiler'
  | 'skill-lazy-loading'
  | 'artifact-store'
  | 'cache-architecture'
  | 'capability-aware-model-routing'
  | 'evals-in-ci'
  | 'observability'
  | 'legacy-ai-paths';

export type Phase23LocalEvidenceKind = 'test' | 'fixture' | 'workflow';
export type Phase23LocalCheckStatus = 'passed' | 'failed' | 'pending';

export interface Phase23LocalSource {
  kind: Phase23LocalEvidenceKind;
  ref: string;
  marker: string;
}

export interface Phase23AtomicCondition {
  id: Phase23AtomicConditionId;
  planText: string;
  sources: readonly Phase23LocalSource[];
}

export interface Phase22ReliabilityScenario {
  id: string;
  planText: string;
  sources: readonly Phase23LocalSource[];
}

export interface Phase23LocalCheck {
  id: string;
  status: Phase23LocalCheckStatus;
  sources: readonly Phase23LocalSource[];
}

export interface Phase23ExternalEvidenceReference {
  id: string;
  source: 'external' | 'replay';
  status: string;
}

export interface Phase23LocalGateInput {
  checks?: readonly Phase23LocalCheck[];
  reliability?: readonly Phase23LocalCheck[];
  externalEvidence?: readonly Phase23ExternalEvidenceReference[];
}

export interface Phase23LocalConditionResult {
  id: string;
  planText: string;
  status: Phase23LocalCheckStatus;
  sourceRefs: string[];
}

export interface Phase23LocalMatrixResult {
  requiredCount: number;
  passedCount: number;
  missing: string[];
  failed: string[];
  invalid: string[];
  conditions: Phase23LocalConditionResult[];
}

export interface Phase23LocalGateReport {
  schemaVersion: typeof PHASE23_LOCAL_GATE_SCHEMA_VERSION;
  kind: 'phase23-local-atomic-gate';
  mode: 'deterministic-local';
  status: 'passed' | 'pending';
  eligible: boolean;
  atomicConditionCount: number;
  passedConditionCount: number;
  missingConditions: string[];
  failedConditions: string[];
  invalidConditions: string[];
  reliability: Phase23LocalMatrixResult;
  externalEvidence: {
    policy: 'supplemental-only';
    ignoredCount: number;
    usedForEligibility: false;
  };
}

function testSource(ref: string, marker: string): Phase23LocalSource {
  return Object.freeze({ kind: 'test', ref, marker });
}

function fixtureSource(ref: string, marker: string): Phase23LocalSource {
  return Object.freeze({ kind: 'fixture', ref, marker });
}

function workflowSource(ref: string, marker: string): Phase23LocalSource {
  return Object.freeze({ kind: 'workflow', ref, marker });
}

function condition(
  id: Phase23AtomicConditionId,
  planText: string,
  sources: readonly Phase23LocalSource[]
): Phase23AtomicCondition {
  return Object.freeze({ id, planText, sources: Object.freeze([...sources]) });
}

function reliabilityScenario(
  id: string,
  planText: string,
  sources: readonly Phase23LocalSource[]
): Phase22ReliabilityScenario {
  return Object.freeze({ id, planText, sources: Object.freeze([...sources]) });
}

export const PHASE23_ATOMIC_CONDITIONS = Object.freeze([
  condition('canonical-content', 'Canonical Content Representation 稳定', [
    testSource('tests/semantic-content-boundaries.test.ts', 'Phase 1 canonical content SourceMap boundary matrix'),
    fixtureSource('packages/evals/fixtures/semantic-content/source-map-range.json', 'mutatedRange')
  ]),
  condition('canonical-story-model', 'Canonical Story Model 稳定', [
    testSource('tests/domain-sync.test.ts', 'desktop-authoritative domain projection sync'),
    testSource(
      'tests/final-freeze-cross-boundary.test.ts',
      'persists StoryState provenance, ordered projections, proposals, and artifact lineage over TCP and restart'
    )
  ]),
  condition('continue-prose', 'Continue Prose 稳定', [
    testSource('tests/task-evals.test.ts', "kind: 'creative.continue'"),
    testSource('tests/first-party-skill-activation.test.ts', 'creative.continue')
  ]),
  condition('selection-rewrite', 'Selection Rewrite 稳定', [
    testSource('tests/task-evals.test.ts', "kind: 'creative.rewrite'"),
    testSource('tests/first-party-skill-activation.test.ts', 'creative.rewrite')
  ]),
  condition('continuity-audit', 'Continuity Audit 稳定', [
    testSource('tests/task-contract.test.ts', 'narrative.continuity.audit'),
    testSource('tests/first-party-skill-activation.test.ts', 'narrative.continuity.audit')
  ]),
  condition('deep-story-reasoning', 'Deep Story Reasoning 稳定', [
    testSource('tests/first-party-skill-activation.test.ts', 'narrative.deep.reason')
  ]),
  condition('project-distillation', 'Project Distillation 稳定', [
    testSource('tests/first-party-skill-activation.test.ts', 'narrative.project.distill')
  ]),
  condition('projection-sync', 'Projection Sync 稳定', [
    testSource('tests/domain-sync.test.ts', 'rejects out-of-order revisions and then accepts them in order')
  ]),
  condition('proposal-commit', 'Proposal → Commit 稳定', [
    testSource(
      'tests/runtime-phase9-13.test.ts',
      'keeps proposal review separate from authoritative CAS commit and supports undo'
    ),
    testSource(
      'tests/proposal-sync.test.ts',
      'round-trips proposal state over JSON RPC and enforces hash plus revision CAS'
    )
  ]),
  condition('optimistic-concurrency', 'Optimistic Concurrency 稳定', [
    testSource('tests/proposal-sync.test.ts', 'revision CAS'),
    testSource('tests/phase22-reliability-matrix.test.ts', 'stale proposal')
  ]),
  condition('durable-execution', 'Durable Execution 稳定', [
    testSource(
      'tests/process-restart-e2e.test.ts',
      'recovers a durable task checkpoint through daemon RPC after SIGKILL and restart'
    ),
    testSource('tests/fault-injection-recovery.test.ts', 'retries after an injected checkpoint write failure')
  ]),
  condition('context-pipeline', 'Context Pipeline 稳定', [
    testSource(
      'tests/context-cache-pipeline-integration.test.ts',
      'compiles the real JIT provider, caches the packet, and invalidates by revision'
    ),
    testSource('tests/context-overflow-reliability.test.ts', 'context overflow reliability boundary')
  ]),
  condition('story-context-compiler', 'Story Context Compiler 稳定', [
    testSource(
      'tests/serialized-creative-context-provider.test.ts',
      'projects Desktop payload context through a real Daemon process'
    )
  ]),
  condition('skill-lazy-loading', 'Skill Lazy Loading 稳定', [
    testSource(
      'tests/first-party-skill-activation.test.ts',
      'discovers, lazily loads, and activates each real manifest on shared runtime surfaces'
    ),
    testSource('tests/skills-instructions.test.ts', 'exposes skill metadata first and loads the prompt body on demand')
  ]),
  condition('artifact-store', 'Artifact Store 稳定', [
    testSource(
      'tests/artifact-rpc-e2e.test.ts',
      'persists, reads, and filters artifacts through the real daemon transport'
    )
  ]),
  condition('cache-architecture', 'Cache Architecture 稳定', [
    testSource(
      'tests/runtime-cache-cross-layer.test.ts',
      'reports one task-wide delta and invalidates all populated layers by revision'
    ),
    testSource('tests/runtime-cache-persistence-restart.test.ts', 'Runtime cache persistence across restart')
  ]),
  condition('capability-aware-model-routing', 'Capability-aware Model Routing 稳定', [
    testSource(
      'tests/phase22-reliability-matrix.test.ts',
      'combines model unavailability with capability mismatch before provider or cache access'
    ),
    testSource(
      'tests/provider-route-fallback.test.ts',
      'tries the next compatible route after a retryable provider failure'
    )
  ]),
  condition('evals-in-ci', 'Evals 进入 CI', [
    workflowSource('.github/workflows/evals.yml', 'pnpm run test:evals'),
    workflowSource('.github/workflows/evals.yml', 'tests/phase23-local-freeze.test.ts')
  ]),
  condition('observability', 'Observability 完成', [
    testSource('tests/task-provenance.test.ts', 'covers the public observation fields with deterministic values'),
    testSource('tests/task-observability.test.ts', 'sanitizes direct observation sinks before storing or emitting them')
  ]),
  condition('legacy-ai-paths', '主要 Legacy AI 路径删除', [
    testSource(
      'tests/phase20-21-plugin-legacy-architecture.test.ts',
      'removes legacy AI gateways and stage-name compatibility hooks from Runtime sources'
    )
  ])
] as readonly Phase23AtomicCondition[]);

export const PHASE19_OBSERVABILITY_FIELDS = Object.freeze([
  'taskId',
  'kind',
  'executionRunId',
  'instructionId',
  'instructionVersion',
  'skillIds',
  'skillVersions',
  'contextSources',
  'contextFingerprint',
  'contextTokenCount',
  'projectRevision',
  'provider',
  'model',
  'latencyMs',
  'usage',
  'cache',
  'tools',
  'resultType',
  'artifactIds',
  'proposalIds',
  'checkpointIds',
  'error',
  'provenance'
] as const);

export const PHASE22_RELIABILITY_SCENARIOS = Object.freeze([
  reliabilityScenario('crash-test', 'Crash test', [
    testSource(
      'tests/process-restart-e2e.test.ts',
      'recovers a durable task checkpoint through daemon RPC after SIGKILL and restart'
    )
  ]),
  reliabilityScenario('daemon-restart', 'Daemon restart', [
    testSource('tests/daemon-rpc-e2e.test.ts', 'reloads interrupted execution state after a daemon restart')
  ]),
  reliabilityScenario('offline-desktop', 'Offline Desktop', [
    testSource(
      'tests/provider-capability-matrix-gate.test.ts',
      'accepts an offline route when network access is optional'
    )
  ]),
  reliabilityScenario('broken-network', 'Broken network', [
    testSource('tests/provider-route-fallback.test.ts', 'retryable provider failure')
  ]),
  reliabilityScenario('stale-proposal', 'Stale proposal', [
    testSource('tests/phase22-reliability-matrix.test.ts', 'stale proposal')
  ]),
  reliabilityScenario('duplicate-task', 'Duplicate task', [
    testSource('tests/phase22-reliability-matrix.test.ts', 'rejects a duplicate task')
  ]),
  reliabilityScenario('out-of-order-delta', 'Out-of-order delta', [
    testSource('tests/phase22-reliability-matrix.test.ts', 'out-of-order delivery')
  ]),
  reliabilityScenario('corrupt-checkpoint', 'Corrupt checkpoint', [
    testSource('tests/task-router-durable-boundary.test.ts', 'missing checkpoint')
  ]),
  reliabilityScenario('model-unavailable', 'Model unavailable', [
    testSource('tests/phase22-reliability-matrix.test.ts', 'model unavailability')
  ]),
  reliabilityScenario('provider-capability-mismatch', 'Provider capability mismatch', [
    testSource('tests/phase22-reliability-matrix.test.ts', 'capability mismatch')
  ]),
  reliabilityScenario('invalid-structured-output', 'Invalid structured output', [
    testSource('tests/phase22-reliability-matrix.test.ts', 'invalid structured output')
  ]),
  reliabilityScenario('context-overflow', 'Context overflow', [
    testSource('tests/context-overflow-reliability.test.ts', 'context overflow reliability boundary')
  ]),
  reliabilityScenario('cache-invalidation', 'Cache invalidation', [
    testSource('tests/runtime-cache-cross-layer.test.ts', 'invalidates all populated layers by revision')
  ])
] as readonly Phase22ReliabilityScenario[]);

export const PHASE18_LOCAL_FIXTURE_CONTRACT = Object.freeze({
  mode: 'fixture-only',
  providerCalls: 0,
  modelCalls: 0,
  objectiveKindCount: 7,
  mutationKindCount: 7,
  chapterCounts: Object.freeze([100, 300]),
  evidenceRole: 'deterministic-regression-only',
  realProviderEvidence: 'not-produced',
  humanLabelEvidence: 'not-produced'
} as const);

export function evaluatePhase23LocalGate(input: Phase23LocalGateInput = {}): Phase23LocalGateReport {
  const atomic = evaluateMatrix(PHASE23_ATOMIC_CONDITIONS, input.checks);
  const reliability = evaluateMatrix(PHASE22_RELIABILITY_SCENARIOS, input.reliability);
  const externalEvidence = Array.isArray(input.externalEvidence) ? input.externalEvidence : [];
  const eligible =
    atomic.missing.length === 0 &&
    atomic.failed.length === 0 &&
    atomic.invalid.length === 0 &&
    reliability.missing.length === 0 &&
    reliability.failed.length === 0 &&
    reliability.invalid.length === 0;

  return {
    schemaVersion: PHASE23_LOCAL_GATE_SCHEMA_VERSION,
    kind: 'phase23-local-atomic-gate',
    mode: 'deterministic-local',
    status: eligible ? 'passed' : 'pending',
    eligible,
    atomicConditionCount: atomic.requiredCount,
    passedConditionCount: atomic.passedCount,
    missingConditions: atomic.missing,
    failedConditions: atomic.failed,
    invalidConditions: atomic.invalid,
    reliability,
    externalEvidence: {
      policy: 'supplemental-only',
      ignoredCount: externalEvidence.length,
      usedForEligibility: false
    }
  };
}

function evaluateMatrix(
  expected: readonly (Phase23AtomicCondition | Phase22ReliabilityScenario)[],
  checks: readonly Phase23LocalCheck[] | undefined
): Phase23LocalMatrixResult {
  const expectedById = new Map(expected.map((entry) => [entry.id, entry]));
  const supplied = Array.isArray(checks) ? checks : [];
  const byId = new Map<string, CandidateLocalCheck>();
  const invalid = new Set<string>();

  for (const check of supplied) {
    const candidate = readCandidateCheck(check);
    if (!candidate || !expectedById.has(candidate.id)) {
      invalid.add(candidate?.id ?? '<unknown>');
      continue;
    }
    if (byId.has(candidate.id)) {
      invalid.add(candidate.id);
      continue;
    }
    byId.set(candidate.id, candidate);
    const expectedEntry = expectedById.get(candidate.id);
    if (!isValidStatus(candidate.status) || !sameSources(candidate.sources, expectedEntry?.sources ?? [])) {
      invalid.add(candidate.id);
    }
  }

  const missing: string[] = [];
  const failed: string[] = [];
  const conditions = expected.map((entry) => {
    const check = byId.get(entry.id);
    const isInvalid = invalid.has(entry.id);
    const status: Phase23LocalCheckStatus =
      isInvalid || check?.status === 'failed' ? 'failed' : check?.status === 'passed' ? 'passed' : 'pending';
    if (status === 'pending') missing.push(entry.id);
    if (status === 'failed') failed.push(entry.id);
    return {
      id: entry.id,
      planText: entry.planText,
      status,
      sourceRefs: readSourceRefs(check?.sources)
    };
  });

  return {
    requiredCount: expected.length,
    passedCount: conditions.filter((entry) => entry.status === 'passed').length,
    missing,
    failed,
    invalid: [...invalid].sort(),
    conditions
  };
}

interface CandidateLocalCheck {
  id: string;
  status: unknown;
  sources: unknown;
}

function readCandidateCheck(value: unknown): CandidateLocalCheck | undefined {
  if (!isRecord(value) || typeof value.id !== 'string') return undefined;
  return { id: value.id, status: value.status, sources: value.sources };
}

function sameSources(actual: unknown, expected: readonly Phase23LocalSource[]): boolean {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  return expected.every((expectedSource) =>
    actual.some(
      (actualSource) =>
        isValidLocalSource(actualSource) &&
        actualSource.kind === expectedSource.kind &&
        normalizeRef(actualSource.ref) === expectedSource.ref &&
        actualSource.marker === expectedSource.marker
    )
  );
}

function readSourceRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isValidLocalSource).map((source) => normalizeRef(source.ref));
}

function isValidStatus(value: unknown): value is Phase23LocalCheckStatus {
  return value === 'passed' || value === 'failed' || value === 'pending';
}

function isValidLocalSource(value: unknown): value is Phase23LocalSource {
  if (
    !isRecord(value) ||
    !isEvidenceKind(value.kind) ||
    typeof value.ref !== 'string' ||
    typeof value.marker !== 'string'
  ) {
    return false;
  }
  if (value.marker.trim().length === 0) return false;
  const ref = normalizeRef(value.ref);
  if (!ref || ref.startsWith('/') || ref.includes('../') || ref.includes('/..')) return false;
  if (/(^|\/)(?:external|replay|inkpi-evidence)(?:\/|$)/i.test(ref)) return false;
  if (value.kind === 'test')
    return (ref.startsWith('tests/') || ref.startsWith('packages/evals/src/')) && ref.endsWith('.test.ts');
  if (value.kind === 'fixture') return ref.startsWith('packages/evals/fixtures/');
  return ref.startsWith('.github/workflows/') && ref.endsWith('.yml');
}

function isEvidenceKind(value: unknown): value is Phase23LocalEvidenceKind {
  return value === 'test' || value === 'fixture' || value === 'workflow';
}

function normalizeRef(value: string): string {
  return value.replaceAll('\\', '/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
