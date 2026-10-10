import { createHash } from 'node:crypto';

export const AB_STUDY_SCHEMA_VERSION = 1 as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

export interface ABStudyVariant {
  id: string;
  configSha256: string;
}

export interface ABStudySlot {
  caseId: string;
  repetition: number;
  order: readonly [string, string];
}

export interface ABStudyPlanInput {
  id: string;
  createdAt?: number;
  artifactSha256: string;
  corpusSha256: string;
  environmentSha256: string;
  evaluationPlanSha256: string;
  control: ABStudyVariant;
  candidate: ABStudyVariant;
  caseIds: readonly string[];
  repetitions: number;
}

export interface ABStudyPlan extends Omit<ABStudyPlanInput, 'createdAt' | 'caseIds' | 'control' | 'candidate'> {
  schemaVersion: typeof AB_STUDY_SCHEMA_VERSION;
  kind: 'paired-ab-study-plan';
  evidenceKind: 'deterministic-local';
  planSha256: string;
  createdAt: number;
  control: Readonly<ABStudyVariant>;
  candidate: Readonly<ABStudyVariant>;
  caseIds: readonly string[];
  slots: readonly ABStudySlot[];
}

/** One run's measurements. Prompts and generated content are intentionally not stored here. */
export interface ABStudyObservation {
  planId: string;
  planSha256: string;
  caseId: string;
  repetition: number;
  variantId: string;
  runSequence: number;
  orderIndex: 0 | 1;
  artifactSha256: string;
  corpusSha256: string;
  environmentSha256: string;
  evaluationPlanSha256: string;
  variantConfigSha256: string;
  startedAt: number;
  qualityScore?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs?: number;
  costUsd?: number;
}

export interface ABStudyMetricComparison {
  status: 'complete' | 'unavailable';
  control?: number;
  candidate?: number;
  candidateMinusControl?: number;
  reason?: string;
}

export interface ABStudyReport {
  kind: 'paired-ab-study-report';
  status: 'complete' | 'unavailable' | 'invalid';
  planId: string;
  planSha256: string;
  expectedObservationCount: number;
  observedObservationCount: number;
  pairedRunCount: number;
  quality: ABStudyMetricComparison;
  inputTokens: ABStudyMetricComparison;
  outputTokens: ABStudyMetricComparison;
  cacheReadTokens: ABStudyMetricComparison;
  cacheWriteTokens: ABStudyMetricComparison;
  durationMs: ABStudyMetricComparison;
  costUsd: ABStudyMetricComparison;
  violations: string[];
}

function requiredText(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function requireSha256(value: string, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} must be a SHA-256 hex digest.`);
  }
  return value.toLowerCase();
}

function variant(input: ABStudyVariant, label: string): Readonly<ABStudyVariant> {
  return Object.freeze({
    id: requiredText(input.id, `${label}.id`),
    configSha256: requireSha256(input.configSha256, `${label}.configSha256`)
  });
}

function hashPlan(plan: Omit<ABStudyPlan, 'planSha256'>): string {
  const canonical = {
    schemaVersion: plan.schemaVersion,
    kind: plan.kind,
    id: plan.id,
    createdAt: plan.createdAt,
    evidenceKind: plan.evidenceKind,
    artifactSha256: plan.artifactSha256,
    corpusSha256: plan.corpusSha256,
    environmentSha256: plan.environmentSha256,
    evaluationPlanSha256: plan.evaluationPlanSha256,
    control: { id: plan.control.id, configSha256: plan.control.configSha256 },
    candidate: { id: plan.candidate.id, configSha256: plan.candidate.configSha256 },
    caseIds: [...plan.caseIds],
    repetitions: plan.repetitions,
    slots: plan.slots.map((slot) => ({
      caseId: slot.caseId,
      repetition: slot.repetition,
      order: [...slot.order]
    }))
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export function createABStudyPlan(input: ABStudyPlanInput): ABStudyPlan {
  const id = requiredText(input.id, 'id');
  const control = variant(input.control, 'control');
  const candidate = variant(input.candidate, 'candidate');
  if (control.id === candidate.id) throw new Error('Control and candidate variant IDs must differ.');

  const caseIds = input.caseIds.map((caseId) => requiredText(caseId, 'caseId'));
  if (caseIds.length === 0) throw new Error('An A/B study requires at least one case.');
  if (new Set(caseIds).size !== caseIds.length) throw new Error('A/B study case IDs must be unique.');
  if (!Number.isInteger(input.repetitions) || input.repetitions < 1 || input.repetitions > 100) {
    throw new Error('A/B study repetitions must be an integer from 1 through 100.');
  }

  const createdAt = input.createdAt ?? Date.now();
  if (!Number.isFinite(createdAt) || createdAt < 0) throw new Error('createdAt must be a non-negative timestamp.');

  const slots = input.caseIds.flatMap((caseId, caseIndex) =>
    Array.from({ length: input.repetitions }, (_, repetition) => {
      const controlFirst = (caseIndex + repetition) % 2 === 0;
      return Object.freeze({
        caseId: caseIds[caseIndex]!,
        repetition,
        order: Object.freeze(controlFirst ? [control.id, candidate.id] : [candidate.id, control.id]) as readonly [
          string,
          string
        ]
      });
    })
  );

  const plan: Omit<ABStudyPlan, 'planSha256'> = {
    schemaVersion: AB_STUDY_SCHEMA_VERSION,
    kind: 'paired-ab-study-plan',
    id,
    createdAt,
    evidenceKind: 'deterministic-local',
    artifactSha256: requireSha256(input.artifactSha256, 'artifactSha256'),
    corpusSha256: requireSha256(input.corpusSha256, 'corpusSha256'),
    environmentSha256: requireSha256(input.environmentSha256, 'environmentSha256'),
    evaluationPlanSha256: requireSha256(input.evaluationPlanSha256, 'evaluationPlanSha256'),
    control,
    candidate,
    caseIds: Object.freeze(caseIds),
    repetitions: input.repetitions,
    slots: Object.freeze(slots)
  };
  return Object.freeze({ ...plan, planSha256: hashPlan(plan) });
}

type NumericMetric = keyof Pick<
  ABStudyObservation,
  'qualityScore' | 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'durationMs' | 'costUsd'
>;

const METRICS: readonly NumericMetric[] = [
  'qualityScore',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'durationMs',
  'costUsd'
];

function observationKey(caseId: string, repetition: number, variantId: string): string {
  return `${caseId}\u0000${repetition}\u0000${variantId}`;
}

function unavailable(reason: string): ABStudyMetricComparison {
  return { status: 'unavailable', reason };
}

function compareMetric(
  observations: readonly ABStudyObservation[],
  controlId: string,
  candidateId: string,
  metric: NumericMetric,
  aggregation: 'mean' | 'sum'
): ABStudyMetricComparison {
  if (observations.some((observation) => observation[metric] === undefined)) {
    return unavailable(`Missing ${metric} measurement.`);
  }

  const aggregate = (variantId: string): number => {
    const values = observations
      .filter((observation) => observation.variantId === variantId)
      .map((observation) => observation[metric] as number);
    const total = values.reduce((sum, value) => sum + value, 0);
    return aggregation === 'mean' ? total / values.length : total;
  };
  const control = aggregate(controlId);
  const candidate = aggregate(candidateId);
  return {
    status: 'complete',
    control,
    candidate,
    candidateMinusControl: candidate - control
  };
}

export function evaluateABStudy(plan: ABStudyPlan, observations: readonly ABStudyObservation[]): ABStudyReport {
  const violations: string[] = [];
  if (plan.planSha256 !== hashPlan(plan)) violations.push('Study plan digest does not match its contents.');
  const expected = new Map<
    string,
    { caseId: string; repetition: number; variantId: string; runSequence: number; orderIndex: 0 | 1 }
  >();
  let runSequence = 0;
  for (const slot of plan.slots) {
    slot.order.forEach((variantId, orderIndex) => {
      expected.set(observationKey(slot.caseId, slot.repetition, variantId), {
        caseId: slot.caseId,
        repetition: slot.repetition,
        variantId,
        runSequence: runSequence++,
        orderIndex: orderIndex as 0 | 1
      });
    });
  }

  const unique = new Map<string, ABStudyObservation>();
  const variantConfigHashes = new Map([
    [plan.control.id, plan.control.configSha256],
    [plan.candidate.id, plan.candidate.configSha256]
  ]);
  for (const observation of observations) {
    const key = observationKey(observation.caseId, observation.repetition, observation.variantId);
    const slot = expected.get(key);
    if (!slot) {
      violations.push(`Unexpected run '${observation.caseId}/${observation.repetition}/${observation.variantId}'.`);
      continue;
    }
    if (unique.has(key)) {
      violations.push(`Duplicate run '${observation.caseId}/${observation.repetition}/${observation.variantId}'.`);
      continue;
    }
    if (observation.planId !== plan.id) violations.push(`Run '${key}' belongs to another plan.`);
    if (observation.planSha256 !== plan.planSha256) violations.push(`Run '${key}' belongs to another plan revision.`);
    if (observation.runSequence !== slot.runSequence)
      violations.push(`Run '${key}' violates the planned run sequence.`);
    if (observation.orderIndex !== slot.orderIndex) violations.push(`Run '${key}' violates the planned run order.`);
    if (
      typeof observation.artifactSha256 !== 'string' ||
      observation.artifactSha256.toLowerCase() !== plan.artifactSha256
    ) {
      violations.push(`Run '${key}' used a different build artifact.`);
    }
    if (typeof observation.corpusSha256 !== 'string' || observation.corpusSha256.toLowerCase() !== plan.corpusSha256) {
      violations.push(`Run '${key}' used a different evaluation corpus.`);
    }
    if (
      typeof observation.environmentSha256 !== 'string' ||
      observation.environmentSha256.toLowerCase() !== plan.environmentSha256
    ) {
      violations.push(`Run '${key}' used a different execution environment.`);
    }
    if (
      typeof observation.evaluationPlanSha256 !== 'string' ||
      observation.evaluationPlanSha256.toLowerCase() !== plan.evaluationPlanSha256
    ) {
      violations.push(`Run '${key}' used a different evaluation plan.`);
    }
    if (
      typeof observation.variantConfigSha256 !== 'string' ||
      observation.variantConfigSha256.toLowerCase() !== variantConfigHashes.get(observation.variantId)
    ) {
      violations.push(`Run '${key}' used a different variant configuration.`);
    }
    if (!Number.isFinite(observation.startedAt) || observation.startedAt < plan.createdAt) {
      violations.push(`Run '${key}' started before the plan was recorded.`);
    }
    for (const metric of METRICS) {
      const value = observation[metric];
      if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
        violations.push(`Run '${key}' has an invalid ${metric} measurement.`);
      }
    }
    if (observation.qualityScore !== undefined && observation.qualityScore > 100) {
      violations.push(`Run '${key}' has a qualityScore above 100.`);
    }
    unique.set(key, observation);
  }

  const validRuns = [...unique.values()];
  const orderedRuns = validRuns
    .filter((observation) => {
      const slot = expected.get(observationKey(observation.caseId, observation.repetition, observation.variantId));
      return slot?.runSequence === observation.runSequence;
    })
    .sort((left, right) => left.runSequence - right.runSequence);
  for (let index = 1; index < orderedRuns.length; index += 1) {
    if (orderedRuns[index]!.startedAt < orderedRuns[index - 1]!.startedAt) {
      violations.push(
        `Run '${observationKey(orderedRuns[index]!.caseId, orderedRuns[index]!.repetition, orderedRuns[index]!.variantId)}' started before the preceding planned run.`
      );
    }
  }
  const expectedObservationCount = expected.size;
  const observedObservationCount = validRuns.length;
  const completeRuns = observedObservationCount === expectedObservationCount && violations.length === 0;
  const pairedRunCount = plan.slots.filter((slot) =>
    slot.order.every((variantId) => unique.has(observationKey(slot.caseId, slot.repetition, variantId)))
  ).length;
  const missingRunReason = `Missing ${expectedObservationCount - observedObservationCount} planned run(s).`;
  const metricObservations = completeRuns ? validRuns : [];
  const metric = (name: NumericMetric, aggregation: 'mean' | 'sum'): ABStudyMetricComparison =>
    violations.length > 0
      ? unavailable('Invalid A/B study evidence.')
      : !completeRuns
        ? unavailable(missingRunReason)
        : compareMetric(metricObservations, plan.control.id, plan.candidate.id, name, aggregation);

  const quality = metric('qualityScore', 'mean');
  return {
    kind: 'paired-ab-study-report',
    status: violations.length > 0 ? 'invalid' : quality.status === 'complete' ? 'complete' : 'unavailable',
    planId: plan.id,
    planSha256: plan.planSha256,
    expectedObservationCount,
    observedObservationCount,
    pairedRunCount,
    quality,
    inputTokens: metric('inputTokens', 'sum'),
    outputTokens: metric('outputTokens', 'sum'),
    cacheReadTokens: metric('cacheReadTokens', 'sum'),
    cacheWriteTokens: metric('cacheWriteTokens', 'sum'),
    durationMs: metric('durationMs', 'mean'),
    costUsd: metric('costUsd', 'sum'),
    violations
  };
}
