import type { SubjectiveGoldSet, SubjectivePairwiseSet } from './subjective-evals.js';

export interface HumanGoldAnnotation {
  caseId: string;
  annotatorId: string;
  label: string;
  score?: number;
  preference?: string;
}

export interface HumanGoldAdjudication {
  status: 'complete' | 'not-required';
  adjudicatorId?: string;
  reason?: string;
  decision?: 'accepted' | 'revised' | 'rejected';
}

export interface HumanGoldAgreement {
  metric: string;
  score: number;
  sampleCount: number;
}

export interface HumanGoldProvenance {
  source: 'human-labelled';
  datasetId: string;
  version: string;
  annotatorIds: readonly string[];
  annotationCount: number;
  annotatedAt: string;
  adjudication: HumanGoldAdjudication;
  agreement?: HumanGoldAgreement;
}

export interface SubjectiveHumanGoldSet extends SubjectiveGoldSet {
  provenance: HumanGoldProvenance;
  annotations: readonly HumanGoldAnnotation[];
}

export interface HumanGoldValidationViolation {
  code: string;
  message: string;
  path?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface HumanGoldValidationReport {
  id: string;
  passed: boolean;
  violations: HumanGoldValidationViolation[];
  metrics: {
    caseCount: number;
    annotationCount: number;
    coveredCaseCount: number;
    annotatorCount: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function validAgreementScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function addViolation(
  violations: HumanGoldValidationViolation[],
  code: string,
  message: string,
  path?: string,
  expected?: unknown,
  actual?: unknown
): void {
  violations.push({ code, message, path, expected, actual });
}

/**
 * Validate the provenance envelope for an actual human-labelled gold set.
 * This validates declared evidence; it does not claim that a label was human
 * generated merely because the envelope is present.
 */
export function validateSubjectiveHumanGoldSet(input: unknown): HumanGoldValidationReport {
  const violations: HumanGoldValidationViolation[] = [];
  const root = isRecord(input) ? input : {};
  const cases = Array.isArray(root.cases) ? root.cases : [];
  const annotations = Array.isArray(root.annotations) ? root.annotations : [];
  const provenance = isRecord(root.provenance) ? root.provenance : undefined;
  const caseIds = new Set<string>();
  const annotatorIds = new Set<string>();
  const coveredCaseIds = new Set<string>();
  const annotationKeys = new Set<string>();

  if (!provenance) {
    addViolation(
      violations,
      'human-gold-provenance-missing',
      'Human-labelled gold sets require a provenance envelope.',
      'provenance',
      'object'
    );
  } else {
    if (provenance.source !== 'human-labelled') {
      addViolation(
        violations,
        'human-gold-source-invalid',
        'Human gold provenance must identify its source as human-labelled.',
        'provenance.source',
        'human-labelled',
        provenance.source
      );
    }
    for (const field of ['datasetId', 'version'] as const) {
      if (!nonEmptyString(provenance[field])) {
        addViolation(
          violations,
          'human-gold-provenance-field-missing',
          `Human gold provenance requires a non-empty ${field}.`,
          `provenance.${field}`
        );
      }
    }
    if (!nonEmptyString(provenance.annotatedAt) || Number.isNaN(Date.parse(provenance.annotatedAt))) {
      addViolation(
        violations,
        'human-gold-timestamp-invalid',
        'Human gold provenance annotatedAt must be a valid timestamp.',
        'provenance.annotatedAt',
        'ISO timestamp',
        provenance.annotatedAt
      );
    }
    const annotationCount = provenance.annotationCount;
    if (typeof annotationCount !== 'number' || !Number.isInteger(annotationCount) || annotationCount < 1) {
      addViolation(
        violations,
        'human-gold-count-invalid',
        'Human gold provenance annotationCount must be a positive integer.',
        'provenance.annotationCount',
        'positive integer',
        provenance.annotationCount
      );
    } else if (annotationCount !== annotations.length) {
      addViolation(
        violations,
        'human-gold-count-mismatch',
        'Human gold annotationCount must match the annotation record count.',
        'provenance.annotationCount',
        annotations.length,
        provenance.annotationCount
      );
    }
    if (!Array.isArray(provenance.annotatorIds) || provenance.annotatorIds.length === 0) {
      addViolation(
        violations,
        'human-gold-annotators-missing',
        'Human gold provenance requires at least one annotator id.',
        'provenance.annotatorIds',
        'non-empty string array',
        provenance.annotatorIds
      );
    } else {
      for (const [index, annotatorId] of provenance.annotatorIds.entries()) {
        if (!nonEmptyString(annotatorId)) {
          addViolation(
            violations,
            'human-gold-annotator-invalid',
            'Human gold annotator ids must be non-empty strings.',
            `provenance.annotatorIds[${index}]`,
            'non-empty string',
            annotatorId
          );
          continue;
        }
        if (annotatorIds.has(annotatorId)) {
          addViolation(
            violations,
            'human-gold-annotator-duplicate',
            `Human gold annotator '${annotatorId}' is duplicated.`,
            `provenance.annotatorIds[${index}]`
          );
        }
        annotatorIds.add(annotatorId);
      }
    }

    const adjudication = provenance.adjudication;
    if (!isRecord(adjudication) || !['complete', 'not-required'].includes(String(adjudication.status))) {
      addViolation(
        violations,
        'human-gold-adjudication-invalid',
        'Human gold provenance requires a complete or explicitly not-required adjudication record.',
        'provenance.adjudication',
        "status 'complete' or 'not-required'",
        adjudication
      );
    } else if (adjudication.status === 'complete') {
      if (!nonEmptyString(adjudication.adjudicatorId)) {
        addViolation(
          violations,
          'human-gold-adjudicator-missing',
          'Completed human gold adjudication requires an adjudicator id.',
          'provenance.adjudication.adjudicatorId'
        );
      }
      if (!['accepted', 'revised', 'rejected'].includes(String(adjudication.decision))) {
        addViolation(
          violations,
          'human-gold-decision-invalid',
          'Completed human gold adjudication requires a decision.',
          'provenance.adjudication.decision',
          'accepted, revised, or rejected',
          adjudication.decision
        );
      }
    } else if (!nonEmptyString(adjudication.reason)) {
      addViolation(
        violations,
        'human-gold-adjudication-reason-missing',
        'A not-required adjudication record must explain why adjudication was not required.',
        'provenance.adjudication.reason'
      );
    }

    if (provenance.agreement !== undefined) {
      const agreement = provenance.agreement;
      const agreementScore = isRecord(agreement) ? agreement.score : undefined;
      const sampleCount = isRecord(agreement) ? agreement.sampleCount : undefined;
      if (
        !isRecord(agreement) ||
        !nonEmptyString(agreement.metric) ||
        !validAgreementScore(agreementScore) ||
        typeof sampleCount !== 'number' ||
        !Number.isInteger(sampleCount) ||
        sampleCount < 1
      ) {
        addViolation(
          violations,
          'human-gold-agreement-invalid',
          'Human gold agreement requires a metric, score between 0 and 1, and a positive sample count.',
          'provenance.agreement',
          '{ metric, score: 0..1, sampleCount: positive integer }',
          agreement
        );
      }
    }
  }

  if (cases.length === 0) {
    addViolation(violations, 'human-gold-cases-empty', 'Human gold set must contain at least one case.', 'cases');
  }
  for (const [index, subjectiveCase] of cases.entries()) {
    const caseId = isRecord(subjectiveCase) && nonEmptyString(subjectiveCase.id) ? subjectiveCase.id : '';
    if (!caseId) {
      addViolation(
        violations,
        'human-gold-case-id-missing',
        'Human gold cases require a non-empty id.',
        `cases[${index}].id`
      );
      continue;
    }
    if (caseIds.has(caseId)) {
      addViolation(
        violations,
        'human-gold-case-duplicate',
        `Human gold case '${caseId}' is duplicated.`,
        `cases[${index}].id`
      );
    }
    caseIds.add(caseId);
  }

  for (const [index, rawAnnotation] of annotations.entries()) {
    if (!isRecord(rawAnnotation)) {
      addViolation(
        violations,
        'human-gold-annotation-invalid',
        'Human gold annotations must be objects.',
        `annotations[${index}]`
      );
      continue;
    }
    const caseId = rawAnnotation.caseId;
    const annotatorId = rawAnnotation.annotatorId;
    const label = rawAnnotation.label;
    if (!nonEmptyString(caseId) || !caseIds.has(caseId)) {
      addViolation(
        violations,
        'human-gold-annotation-case-invalid',
        'Human gold annotation caseId must reference an existing case.',
        `annotations[${index}].caseId`,
        [...caseIds],
        caseId
      );
    } else {
      coveredCaseIds.add(caseId);
    }
    if (!nonEmptyString(annotatorId) || !annotatorIds.has(annotatorId)) {
      addViolation(
        violations,
        'human-gold-annotation-annotator-invalid',
        'Human gold annotation annotatorId must reference a declared annotator.',
        `annotations[${index}].annotatorId`,
        [...annotatorIds],
        annotatorId
      );
    }
    if (!nonEmptyString(label)) {
      addViolation(
        violations,
        'human-gold-label-missing',
        'Human gold annotations require a non-empty label.',
        `annotations[${index}].label`
      );
    }
    if (rawAnnotation.score !== undefined && !validScore(rawAnnotation.score)) {
      addViolation(
        violations,
        'human-gold-score-invalid',
        'Human gold annotation scores must be numbers between 0 and 100.',
        `annotations[${index}].score`,
        '0-100',
        rawAnnotation.score
      );
    }
    if (nonEmptyString(caseId) && nonEmptyString(annotatorId)) {
      const key = `${caseId}\u0000${annotatorId}`;
      if (annotationKeys.has(key)) {
        addViolation(
          violations,
          'human-gold-annotation-duplicate',
          `Human gold annotation '${caseId}' by '${annotatorId}' is duplicated.`,
          `annotations[${index}]`
        );
      }
      annotationKeys.add(key);
    }
  }

  for (const caseId of caseIds) {
    if (!coveredCaseIds.has(caseId)) {
      addViolation(
        violations,
        'human-gold-case-uncovered',
        `Human gold case '${caseId}' has no annotation record.`,
        `cases.${caseId}`
      );
    }
  }

  return {
    id: nonEmptyString(root.id) ? root.id : 'subjective-human-gold',
    passed: violations.length === 0,
    violations,
    metrics: {
      caseCount: cases.length,
      annotationCount: annotations.length,
      coveredCaseCount: coveredCaseIds.size,
      annotatorCount: annotatorIds.size
    }
  };
}

export const validateHumanGoldSet = validateSubjectiveHumanGoldSet;

export interface HumanPairwiseAnnotation {
  comparisonId: string;
  annotatorId: string;
  preference: string;
}

export interface SubjectiveHumanPairwiseSet extends SubjectivePairwiseSet {
  provenance: HumanGoldProvenance;
  annotations: readonly HumanPairwiseAnnotation[];
}

export interface HumanPairwiseValidationReport {
  id: string;
  passed: boolean;
  violations: HumanGoldValidationViolation[];
  metrics: {
    comparisonCount: number;
    annotationCount: number;
    coveredComparisonCount: number;
    annotatorCount: number;
  };
}

function pairwiseReferenceId(reference: unknown): string {
  if (nonEmptyString(reference)) return reference.trim();
  return isRecord(reference) && nonEmptyString(reference.id) ? reference.id.trim() : '';
}

function pairwisePreference(value: unknown): string {
  return nonEmptyString(value) ? value.trim() : '';
}

function pairwisePreferenceIsValid(value: string, left: string, right: string): boolean {
  return (
    value === 'tie' || value === 'draw' || value === 'left' || value === 'right' || value === left || value === right
  );
}

function validatePairwiseProvenance(
  value: unknown,
  annotationCount: number,
  violations: HumanGoldValidationViolation[]
): Set<string> {
  const annotatorIds = new Set<string>();
  if (!isRecord(value)) {
    addViolation(
      violations,
      'human-gold-provenance-missing',
      'Human-labelled pairwise sets require a provenance envelope.',
      'provenance',
      'object'
    );
    return annotatorIds;
  }

  if (value.source !== 'human-labelled') {
    addViolation(
      violations,
      'human-gold-source-invalid',
      'Human pairwise provenance must identify its source as human-labelled.',
      'provenance.source',
      'human-labelled',
      value.source
    );
  }
  for (const field of ['datasetId', 'version'] as const) {
    if (!nonEmptyString(value[field])) {
      addViolation(
        violations,
        'human-gold-provenance-field-missing',
        `Human pairwise provenance requires a non-empty ${field}.`,
        `provenance.${field}`
      );
    }
  }
  if (!nonEmptyString(value.annotatedAt) || Number.isNaN(Date.parse(value.annotatedAt))) {
    addViolation(
      violations,
      'human-gold-timestamp-invalid',
      'Human pairwise provenance annotatedAt must be a valid timestamp.',
      'provenance.annotatedAt',
      'ISO timestamp',
      value.annotatedAt
    );
  }
  if (!Number.isInteger(value.annotationCount) || (value.annotationCount as number) < 1) {
    addViolation(
      violations,
      'human-gold-count-invalid',
      'Human pairwise provenance annotationCount must be a positive integer.',
      'provenance.annotationCount',
      'positive integer',
      value.annotationCount
    );
  } else if (value.annotationCount !== annotationCount) {
    addViolation(
      violations,
      'human-gold-count-mismatch',
      'Human pairwise annotationCount must match the annotation record count.',
      'provenance.annotationCount',
      annotationCount,
      value.annotationCount
    );
  }

  if (!Array.isArray(value.annotatorIds) || value.annotatorIds.length === 0) {
    addViolation(
      violations,
      'human-gold-annotators-missing',
      'Human pairwise provenance requires at least one annotator id.',
      'provenance.annotatorIds',
      'non-empty string array',
      value.annotatorIds
    );
  } else {
    for (const [index, annotatorId] of value.annotatorIds.entries()) {
      if (!nonEmptyString(annotatorId)) {
        addViolation(
          violations,
          'human-gold-annotator-invalid',
          'Human pairwise annotator ids must be non-empty strings.',
          `provenance.annotatorIds[${index}]`,
          'non-empty string',
          annotatorId
        );
        continue;
      }
      const normalized = annotatorId.trim();
      if (annotatorIds.has(normalized)) {
        addViolation(
          violations,
          'human-gold-annotator-duplicate',
          `Human pairwise annotator '${normalized}' is duplicated.`,
          `provenance.annotatorIds[${index}]`
        );
      }
      annotatorIds.add(normalized);
    }
  }

  const adjudication = value.adjudication;
  if (!isRecord(adjudication) || !['complete', 'not-required'].includes(String(adjudication.status))) {
    addViolation(
      violations,
      'human-gold-adjudication-invalid',
      'Human pairwise provenance requires an adjudication record.',
      'provenance.adjudication',
      "status 'complete' or 'not-required'",
      adjudication
    );
  } else if (adjudication.status === 'complete') {
    if (!nonEmptyString(adjudication.adjudicatorId)) {
      addViolation(
        violations,
        'human-gold-adjudicator-missing',
        'Completed human pairwise adjudication requires an adjudicator id.',
        'provenance.adjudication.adjudicatorId'
      );
    }
    if (!['accepted', 'revised', 'rejected'].includes(String(adjudication.decision))) {
      addViolation(
        violations,
        'human-gold-decision-invalid',
        'Completed human pairwise adjudication requires a decision.',
        'provenance.adjudication.decision',
        'accepted, revised, or rejected',
        adjudication.decision
      );
    }
  } else if (!nonEmptyString(adjudication.reason)) {
    addViolation(
      violations,
      'human-gold-adjudication-reason-missing',
      'A not-required pairwise adjudication record must explain why adjudication was not required.',
      'provenance.adjudication.reason'
    );
  }

  if (value.agreement !== undefined) {
    const agreement = value.agreement;
    const agreementScore = isRecord(agreement) ? agreement.score : undefined;
    if (
      !isRecord(agreement) ||
      !nonEmptyString(agreement.metric) ||
      !validAgreementScore(agreementScore) ||
      !Number.isInteger(agreement.sampleCount) ||
      (agreement.sampleCount as number) < 1
    ) {
      addViolation(
        violations,
        'human-gold-agreement-invalid',
        'Human pairwise agreement requires a metric, score between 0 and 1, and a positive sample count.',
        'provenance.agreement',
        '{ metric, score: 0..1, sampleCount: positive integer }',
        agreement
      );
    }
  }
  return annotatorIds;
}

function comparisonPreference(comparison: Record<string, unknown>, kind: 'expected' | 'observed'): string {
  if (kind === 'expected') {
    return pairwisePreference(comparison.expectedPreference ?? comparison.goldPreference ?? comparison.preference);
  }
  return pairwisePreference(comparison.observedPreference ?? comparison.actualPreference ?? comparison.winner);
}

/**
 * Validate the evidence envelope for a human-labelled pairwise set. The
 * evaluator still performs the score calculation; this function only makes
 * sure that a fixture cannot silently stand in for human observations.
 */
export function validateSubjectiveHumanPairwiseSet(input: unknown): HumanPairwiseValidationReport {
  const root = isRecord(input) ? input : {};
  const violations: HumanGoldValidationViolation[] = [];
  const comparisons = Array.isArray(root.comparisons) ? root.comparisons : [];
  const annotations = Array.isArray(root.annotations) ? root.annotations : [];
  const annotatorIds = validatePairwiseProvenance(root.provenance, annotations.length, violations);
  const comparisonIds = new Set<string>();
  const comparisonRefs = new Map<string, { left: string; right: string }>();
  const coveredComparisonIds = new Set<string>();
  const annotationKeys = new Set<string>();

  if (comparisons.length === 0) {
    addViolation(
      violations,
      'human-pairwise-empty',
      'Human-labelled pairwise sets require at least one comparison.',
      'comparisons',
      'non-empty'
    );
  }
  for (const [index, rawComparison] of comparisons.entries()) {
    if (!isRecord(rawComparison)) {
      addViolation(
        violations,
        'human-pairwise-comparison-invalid',
        'Human pairwise comparisons must be objects.',
        `comparisons[${index}]`
      );
      continue;
    }
    const comparison = rawComparison as Record<string, unknown>;
    const id = nonEmptyString(comparison.id) ? comparison.id.trim() : '';
    if (!id) {
      addViolation(
        violations,
        'human-pairwise-comparison-id-missing',
        'Pairwise comparisons require a non-empty id.',
        `comparisons[${index}].id`
      );
    } else if (comparisonIds.has(id)) {
      addViolation(
        violations,
        'human-pairwise-comparison-duplicate',
        `Human pairwise comparison '${id}' is duplicated.`,
        `comparisons[${index}].id`
      );
    } else {
      comparisonIds.add(id);
    }

    const left = pairwiseReferenceId(comparison.left);
    const right = pairwiseReferenceId(comparison.right);
    if (!left || !right || left === right) {
      addViolation(
        violations,
        'human-pairwise-candidate-invalid',
        'Human pairwise comparisons require two distinct candidate ids.',
        `comparisons[${index}]`
      );
    } else if (id) {
      comparisonRefs.set(id, { left, right });
    }

    const expected = comparisonPreference(comparison, 'expected');
    const observed = comparisonPreference(comparison, 'observed');
    if (!expected) {
      addViolation(
        violations,
        'human-pairwise-expected-missing',
        'Human pairwise comparisons require an explicit expected preference.',
        `comparisons[${index}].expectedPreference`
      );
    } else if (left && right && !pairwisePreferenceIsValid(expected, left, right)) {
      addViolation(
        violations,
        'human-pairwise-expected-invalid',
        'Human pairwise expected preference must select the left, right, or tie.',
        `comparisons[${index}].expectedPreference`
      );
    }
    if (!observed) {
      addViolation(
        violations,
        'human-pairwise-observed-missing',
        'Human pairwise comparisons require an explicit observed preference.',
        `comparisons[${index}].observedPreference`
      );
    } else if (left && right && !pairwisePreferenceIsValid(observed, left, right)) {
      addViolation(
        violations,
        'human-pairwise-observed-invalid',
        'Human pairwise observed preference must select the left, right, or tie.',
        `comparisons[${index}].observedPreference`
      );
    }
  }

  for (const [index, rawAnnotation] of annotations.entries()) {
    if (!isRecord(rawAnnotation)) {
      addViolation(
        violations,
        'human-pairwise-annotation-invalid',
        'Human pairwise annotations must be objects.',
        `annotations[${index}]`
      );
      continue;
    }
    const comparisonId = nonEmptyString(rawAnnotation.comparisonId) ? rawAnnotation.comparisonId.trim() : '';
    const annotatorId = nonEmptyString(rawAnnotation.annotatorId) ? rawAnnotation.annotatorId.trim() : '';
    const preference = pairwisePreference(rawAnnotation.preference);
    const comparison = comparisonRefs.get(comparisonId);
    if (!comparisonId || !comparison) {
      addViolation(
        violations,
        'human-pairwise-annotation-comparison-invalid',
        'Human pairwise annotations must reference an existing comparison.',
        `annotations[${index}].comparisonId`
      );
    } else {
      coveredComparisonIds.add(comparisonId);
      if (preference && !pairwisePreferenceIsValid(preference, comparison.left, comparison.right)) {
        addViolation(
          violations,
          'human-pairwise-annotation-preference-invalid',
          'Human pairwise annotation preference must select the compared candidates or tie.',
          `annotations[${index}].preference`
        );
      }
    }
    if (!annotatorId || !annotatorIds.has(annotatorId)) {
      addViolation(
        violations,
        'human-pairwise-annotation-annotator-invalid',
        'Human pairwise annotations must reference a declared annotator.',
        `annotations[${index}].annotatorId`
      );
    }
    if (!preference) {
      addViolation(
        violations,
        'human-pairwise-annotation-preference-missing',
        'Human pairwise annotations require a preference.',
        `annotations[${index}].preference`
      );
    }
    if (comparisonId && annotatorId) {
      const key = `${comparisonId}\u0000${annotatorId}`;
      if (annotationKeys.has(key)) {
        addViolation(
          violations,
          'human-pairwise-annotation-duplicate',
          `Human pairwise annotation '${comparisonId}' by '${annotatorId}' is duplicated.`,
          `annotations[${index}]`
        );
      }
      annotationKeys.add(key);
    }
  }

  for (const comparisonId of comparisonIds) {
    if (!coveredComparisonIds.has(comparisonId)) {
      addViolation(
        violations,
        'human-pairwise-comparison-uncovered',
        `Human pairwise comparison '${comparisonId}' has no annotation record.`,
        `comparisons.${comparisonId}`
      );
    }
  }

  return {
    id: nonEmptyString(root.id) ? root.id.trim() : 'subjective-human-pairwise',
    passed: violations.length === 0,
    violations,
    metrics: {
      comparisonCount: comparisons.length,
      annotationCount: annotations.length,
      coveredComparisonCount: coveredComparisonIds.size,
      annotatorCount: annotatorIds.size
    }
  };
}

export const validateHumanPairwiseSet = validateSubjectiveHumanPairwiseSet;
