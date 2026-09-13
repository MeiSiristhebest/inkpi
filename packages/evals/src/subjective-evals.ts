export type SubjectiveTask =
  | 'hook'
  | 'style'
  | 'voice'
  | 'commercial-tension'
  | 'rewrite'
  | 'rewrite-quality'
  | (string & {});

export type SubjectivePreference = 'tie' | (string & {});

export interface SubjectiveCandidate {
  id?: string;
  text?: string;
  format?: string;
  outputFormat?: string;
  score?: number;
  rubricScores?: Readonly<Record<string, number>>;
  scores?: Readonly<Record<string, number>>;
  labels?: readonly string[];
  metadata?: Readonly<Record<string, unknown>>;
}

export interface SubjectiveRubricCriterion {
  id: string;
  weight?: number;
  minScore?: number;
  required?: boolean;
}

export type SubjectiveRubricCriterionInput = string | SubjectiveRubricCriterion;

export interface SubjectiveRubric {
  id?: string;
  threshold?: number;
  criterionThreshold?: number;
  criteria?: readonly SubjectiveRubricCriterionInput[];
  rubric?: readonly SubjectiveRubricCriterionInput[];
}

export interface SubjectiveRubricEvaluationInput {
  rubric: SubjectiveRubric;
  scores?: Readonly<Record<string, number>>;
  rubricScores?: Readonly<Record<string, number>>;
}

export interface SubjectiveCheck {
  passed: boolean;
  score: number;
  details?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface SubjectiveViolation {
  code: string;
  message: string;
  path?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface SubjectiveRubricReport {
  rubricId: string;
  score: number;
  passed: boolean;
  checks: Record<string, SubjectiveCheck>;
  violations: SubjectiveViolation[];
  metrics: {
    criterionCount: number;
    scoredCriterionCount: number;
    requiredFailureCount: number;
    extraScoreCount: number;
    threshold: number;
    weightedScore: number;
  };
}

export interface SubjectiveGoldContract {
  threshold?: number;
  expectedScore?: number;
  scoreTolerance?: number;
  minScore?: number;
  maxScore?: number;
  expectedFormat?: string;
  requiredPhrases?: readonly string[];
  forbiddenPhrases?: readonly string[];
  requiredLabels?: readonly string[];
  forbiddenLabels?: readonly string[];
  expectedRubricScores?: Readonly<Record<string, number>>;
  rubric?: SubjectiveRubric;
}

export interface SubjectiveGoldCase {
  id?: string;
  task?: SubjectiveTask;
  kind?: SubjectiveTask;
  category?: SubjectiveTask;
  input?: string;
  candidate: SubjectiveCandidate;
  gold: SubjectiveGoldContract;
}

export interface SubjectiveGoldSet {
  id?: string;
  threshold?: number;
  cases: readonly SubjectiveGoldCase[];
}

export interface SubjectiveGoldCaseReport {
  id: string;
  task: SubjectiveTask;
  candidateId: string;
  score: number;
  passed: boolean;
  checks: Record<string, SubjectiveCheck>;
  violations: SubjectiveViolation[];
  metrics: {
    threshold: number;
    rubricScore: number | undefined;
  };
}

export interface SubjectiveGoldSetReport {
  id: string;
  score: number;
  passed: boolean;
  cases: SubjectiveGoldCaseReport[];
  caseReports: SubjectiveGoldCaseReport[];
  violations: SubjectiveViolation[];
  metrics: {
    caseCount: number;
    passedCaseCount: number;
    failedCaseCount: number;
    passRatePercent: number;
    averageScore: number;
    threshold: number;
  };
}

export type SubjectiveCandidateReference = string | SubjectiveCandidate;

export interface SubjectivePairwiseComparison {
  id?: string;
  left: SubjectiveCandidateReference;
  right: SubjectiveCandidateReference;
  expectedPreference?: SubjectivePreference;
  goldPreference?: SubjectivePreference;
  preference?: SubjectivePreference;
  observedPreference?: SubjectivePreference;
  actualPreference?: SubjectivePreference;
  winner?: SubjectivePreference;
  weight?: number;
}

export interface SubjectivePairwiseSet {
  id?: string;
  threshold?: number;
  candidates?: readonly SubjectiveCandidate[];
  comparisons: readonly SubjectivePairwiseComparison[];
  /**
   * Human-labelled gold sets must provide an observed preference explicitly.
   * When false/omitted, deterministic score-derived preferences remain
   * available for fixture-only evaluation.
   */
  requireExplicitObservedPreference?: boolean;
}

export interface SubjectivePairwiseComparisonReport {
  id: string;
  left: string;
  right: string;
  expectedPreference: SubjectivePreference | undefined;
  observedPreference: SubjectivePreference | undefined;
  weight: number;
  score: number;
  passed: boolean;
}

export interface SubjectiveRankingEntry {
  candidateId: string;
  rank: number;
  score: number;
  points: number;
  wins: number;
  losses: number;
  ties: number;
  comparisons: number;
  winRate: number;
}

export interface SubjectivePairwiseReport {
  id: string;
  score: number;
  passed: boolean;
  comparisons: SubjectivePairwiseComparisonReport[];
  ranking: SubjectiveRankingEntry[];
  expectedRanking: SubjectiveRankingEntry[];
  violations: SubjectiveViolation[];
  metrics: {
    comparisonCount: number;
    validComparisonCount: number;
    correctComparisonCount: number;
    accuracyPercent: number;
    tieCount: number;
    candidateCount: number;
    threshold: number;
  };
}

const DEFAULT_SUBJECTIVE_THRESHOLD = 85;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isValidScore(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isValidThreshold(value: unknown): value is number {
  return isValidScore(value);
}

function normalizedId(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedPhraseList(value: readonly string[] | undefined): string[] {
  return Array.isArray(value) ? value.filter((phrase) => typeof phrase === 'string' && phrase.length > 0) : [];
}

function addViolation(
  violations: SubjectiveViolation[],
  code: string,
  message: string,
  path?: string,
  expected?: unknown,
  actual?: unknown
): void {
  violations.push({ code, message, path, expected, actual });
}

function check(
  checks: Record<string, SubjectiveCheck>,
  violations: SubjectiveViolation[],
  key: string,
  passed: boolean,
  details: string,
  expected?: unknown,
  actual?: unknown,
  code = 'contract-check-failed'
): void {
  checks[key] = { passed, score: passed ? 100 : 0, details, expected, actual };
  if (!passed) addViolation(violations, code, details, key, expected, actual);
}

function rubricCriteria(rubric: SubjectiveRubric | undefined): SubjectiveRubricCriterion[] {
  const rawCriteria = rubric?.criteria ?? rubric?.rubric ?? [];
  return rawCriteria.flatMap((criterion) => {
    if (typeof criterion === 'string') return [{ id: criterion }];
    if (isRecord(criterion) && typeof criterion.id === 'string') {
      return [
        {
          id: criterion.id,
          weight: typeof criterion.weight === 'number' ? criterion.weight : undefined,
          minScore: typeof criterion.minScore === 'number' ? criterion.minScore : undefined,
          required: criterion.required === true
        }
      ];
    }
    return [];
  });
}

function scoreMap(candidate: SubjectiveCandidate): Readonly<Record<string, number>> | undefined {
  return candidate.rubricScores ?? candidate.scores;
}

function averageCandidateScore(candidate: SubjectiveCandidate): number | undefined {
  if (candidate.score !== undefined) return isValidScore(candidate.score) ? Math.round(candidate.score) : undefined;
  const scores = scoreMap(candidate);
  if (!scores) return undefined;
  const values = Object.values(scores);
  if (values.length === 0 || values.some((value) => !isValidScore(value))) return undefined;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function thresholdOrDefault(value: unknown, fallback = DEFAULT_SUBJECTIVE_THRESHOLD): number {
  return isValidThreshold(value) ? value : fallback;
}

export function evaluateSubjectiveRubric(input: SubjectiveRubricEvaluationInput): SubjectiveRubricReport {
  const rubric = input.rubric;
  const violations: SubjectiveViolation[] = [];
  const checks: Record<string, SubjectiveCheck> = {};
  const criteria = rubricCriteria(rubric);
  const rawCriteria = rubric?.criteria ?? rubric?.rubric ?? [];
  const threshold = thresholdOrDefault(rubric?.threshold);
  const scores = input.scores ?? input.rubricScores ?? {};
  const criterionIds = new Set<string>();

  if (!isValidThreshold(rubric?.threshold) && rubric?.threshold !== undefined) {
    addViolation(
      violations,
      'rubric-threshold-invalid',
      'Rubric threshold must be a number between 0 and 100.',
      'rubric.threshold',
      '0-100',
      rubric.threshold
    );
  }
  if (!isValidThreshold(rubric?.criterionThreshold) && rubric?.criterionThreshold !== undefined) {
    addViolation(
      violations,
      'criterion-threshold-invalid',
      'Rubric criterion threshold must be a number between 0 and 100.',
      'rubric.criterionThreshold',
      '0-100',
      rubric.criterionThreshold
    );
  }
  if (rawCriteria.length === 0) {
    addViolation(
      violations,
      'rubric-empty',
      'Rubric must define at least one criterion.',
      'rubric.criteria',
      'non-empty',
      rawCriteria
    );
  }

  let weightedScore = 0;
  let totalWeight = 0;
  let scoredCriterionCount = 0;
  let requiredFailureCount = 0;
  for (const [index, criterion] of criteria.entries()) {
    const id = normalizedId(criterion.id);
    if (!id) {
      addViolation(
        violations,
        'criterion-id-missing',
        'Rubric criteria require a non-empty id.',
        `rubric.criteria[${index}].id`
      );
      continue;
    }
    if (criterionIds.has(id)) {
      addViolation(
        violations,
        'criterion-duplicate',
        `Rubric criterion '${id}' is duplicated.`,
        `rubric.criteria[${index}].id`
      );
    }
    criterionIds.add(id);

    const weight = criterion.weight ?? 1;
    const validWeight = Number.isFinite(weight) && weight >= 0;
    if (!validWeight) {
      addViolation(
        violations,
        'criterion-weight-invalid',
        `Rubric criterion '${id}' has an invalid weight.`,
        `rubric.criteria[${index}].weight`,
        'finite number >= 0',
        weight
      );
    }
    const effectiveWeight = validWeight ? weight : 0;
    totalWeight += effectiveWeight;

    const minimum = criterion.minScore ?? (criterion.required ? (rubric?.criterionThreshold ?? threshold) : undefined);
    if (criterion.minScore !== undefined && !isValidScore(criterion.minScore)) {
      addViolation(
        violations,
        'criterion-min-score-invalid',
        `Rubric criterion '${id}' has an invalid minimum score.`,
        `rubric.criteria[${index}].minScore`,
        '0-100',
        criterion.minScore
      );
    }
    const rawScore = scores[id];
    const scoreIsValid = isValidScore(rawScore);
    if (rawScore === undefined) {
      addViolation(
        violations,
        'criterion-score-missing',
        `Rubric score for '${id}' is missing.`,
        `scores.${id}`,
        '0-100'
      );
    } else if (!scoreIsValid) {
      addViolation(
        violations,
        'criterion-score-invalid',
        `Rubric score for '${id}' must be a number between 0 and 100.`,
        `scores.${id}`,
        '0-100',
        rawScore
      );
    } else {
      scoredCriterionCount += 1;
    }

    const actual = scoreIsValid ? rawScore : 0;
    const criterionPassed =
      scoreIsValid && (minimum === undefined || !isValidScore(minimum) ? minimum === undefined : actual >= minimum);
    if (criterion.required && !criterionPassed) requiredFailureCount += 1;
    weightedScore += actual * effectiveWeight;
    checks[id] = {
      passed: criterionPassed,
      score: criterionPassed ? 100 : 0,
      details: minimum === undefined ? `score ${actual}/100` : `score ${actual}/100, minimum ${minimum}/100`,
      expected: minimum === undefined ? 'scored' : minimum,
      actual
    };
  }

  if (totalWeight === 0) {
    addViolation(
      violations,
      'rubric-weight-empty',
      'Rubric must have a positive total criterion weight.',
      'rubric.criteria',
      '> 0',
      totalWeight
    );
  }
  const score = totalWeight === 0 ? 0 : Math.round(weightedScore / totalWeight);
  const overallPassed =
    criteria.length > 0 && score >= threshold && requiredFailureCount === 0 && violations.length === 0;
  checks.overall = {
    passed: overallPassed,
    score: overallPassed ? 100 : 0,
    details: `weighted score ${score}/100, threshold ${threshold}/100`,
    expected: threshold,
    actual: score
  };
  if (!overallPassed && score < threshold) {
    addViolation(
      violations,
      'rubric-score-below-threshold',
      'Rubric score is below the pass threshold.',
      'score',
      threshold,
      score
    );
  }

  const extraScoreCount = Object.keys(scores).filter((id) => !criterionIds.has(id)).length;
  return {
    rubricId: normalizedId(rubric?.id) || 'subjective-rubric',
    score,
    passed: overallPassed,
    checks,
    violations,
    metrics: {
      criterionCount: criteria.length,
      scoredCriterionCount,
      requiredFailureCount,
      extraScoreCount,
      threshold,
      weightedScore: totalWeight === 0 ? 0 : weightedScore / totalWeight
    }
  };
}

function evaluateTextContract(
  candidate: SubjectiveCandidate,
  contract: SubjectiveGoldContract,
  checks: Record<string, SubjectiveCheck>,
  violations: SubjectiveViolation[]
): void {
  const text = typeof candidate.text === 'string' ? candidate.text : undefined;
  const requiredPhrases = normalizedPhraseList(contract.requiredPhrases);
  const forbiddenPhrases = normalizedPhraseList(contract.forbiddenPhrases);
  if (requiredPhrases.length > 0) {
    const passed = text !== undefined && requiredPhrases.every((phrase) => text.includes(phrase));
    check(
      checks,
      violations,
      'requiredPhrases',
      passed,
      passed ? 'all required phrases are present' : 'one or more required phrases are missing',
      requiredPhrases,
      text,
      'required-phrase-missing'
    );
  }
  if (forbiddenPhrases.length > 0) {
    const found = text === undefined ? [] : forbiddenPhrases.filter((phrase) => text.includes(phrase));
    check(
      checks,
      violations,
      'forbiddenPhrases',
      found.length === 0,
      found.length === 0 ? 'no forbidden phrases are present' : 'one or more forbidden phrases are present',
      [],
      found,
      'forbidden-phrase-found'
    );
  }
}

function evaluateLabelContract(
  candidate: SubjectiveCandidate,
  contract: SubjectiveGoldContract,
  checks: Record<string, SubjectiveCheck>,
  violations: SubjectiveViolation[]
): void {
  const labels = new Set(candidate.labels ?? []);
  const requiredLabels = normalizedPhraseList(contract.requiredLabels);
  const forbiddenLabels = normalizedPhraseList(contract.forbiddenLabels);
  if (requiredLabels.length > 0) {
    const passed = requiredLabels.every((label) => labels.has(label));
    check(
      checks,
      violations,
      'requiredLabels',
      passed,
      passed ? 'all required labels are present' : 'one or more required labels are missing',
      requiredLabels,
      candidate.labels ?? [],
      'required-label-missing'
    );
  }
  if (forbiddenLabels.length > 0) {
    const found = forbiddenLabels.filter((label) => labels.has(label));
    check(
      checks,
      violations,
      'forbiddenLabels',
      found.length === 0,
      found.length === 0 ? 'no forbidden labels are present' : 'one or more forbidden labels are present',
      [],
      found,
      'forbidden-label-found'
    );
  }
}

function evaluateExpectedRubricScores(
  candidate: SubjectiveCandidate,
  contract: SubjectiveGoldContract,
  tolerance: number,
  checks: Record<string, SubjectiveCheck>,
  violations: SubjectiveViolation[]
): void {
  const expectedScores = contract.expectedRubricScores;
  if (!expectedScores) return;
  const actualScores = scoreMap(candidate) ?? {};
  const failed: string[] = [];
  for (const [id, expected] of Object.entries(expectedScores)) {
    const actual = actualScores[id];
    const passed = isValidScore(expected) && isValidScore(actual) && Math.abs(actual - expected) <= tolerance;
    if (!passed) failed.push(id);
  }
  check(
    checks,
    violations,
    'expectedRubricScores',
    failed.length === 0,
    failed.length === 0 ? 'all expected rubric scores match' : `rubric scores differ for: ${failed.join(', ')}`,
    expectedScores,
    actualScores,
    'rubric-score-mismatch'
  );
}

export function evaluateSubjectiveGoldCase(
  input: SubjectiveGoldCase,
  defaultThreshold = DEFAULT_SUBJECTIVE_THRESHOLD
): SubjectiveGoldCaseReport {
  const candidate = input.candidate ?? {};
  const contract = input.gold ?? {};
  const violations: SubjectiveViolation[] = [];
  const checks: Record<string, SubjectiveCheck> = {};
  const candidateId = normalizedId(candidate.id) || normalizedId(input.id) || 'candidate';
  const threshold = thresholdOrDefault(contract.threshold, defaultThreshold);

  if (!isValidThreshold(contract.threshold) && contract.threshold !== undefined) {
    addViolation(
      violations,
      'gold-threshold-invalid',
      'Gold threshold must be a number between 0 and 100.',
      'gold.threshold',
      '0-100',
      contract.threshold
    );
  }
  if (
    contract.scoreTolerance !== undefined &&
    (!Number.isFinite(contract.scoreTolerance) || contract.scoreTolerance < 0)
  ) {
    addViolation(
      violations,
      'score-tolerance-invalid',
      'Gold score tolerance must be a finite number >= 0.',
      'gold.scoreTolerance',
      'finite number >= 0',
      contract.scoreTolerance
    );
  }
  const tolerance =
    contract.scoreTolerance !== undefined && Number.isFinite(contract.scoreTolerance) && contract.scoreTolerance >= 0
      ? contract.scoreTolerance
      : 0;
  const rubricReport = contract.rubric
    ? evaluateSubjectiveRubric({ rubric: contract.rubric, scores: scoreMap(candidate) })
    : undefined;

  let actualScore: number | undefined;
  if (candidate.score !== undefined) {
    if (!isValidScore(candidate.score)) {
      addViolation(
        violations,
        'candidate-score-invalid',
        'Candidate score must be a number between 0 and 100.',
        'candidate.score',
        '0-100',
        candidate.score
      );
    } else {
      actualScore = Math.round(candidate.score);
    }
  } else if (rubricReport) {
    actualScore = rubricReport.score;
  } else {
    actualScore = averageCandidateScore(candidate);
    if (actualScore === undefined) {
      addViolation(
        violations,
        'candidate-score-missing',
        'Candidate must provide a score or rubric scores.',
        'candidate.score',
        '0-100'
      );
    }
  }

  if (rubricReport) {
    check(
      checks,
      violations,
      'rubric',
      rubricReport.passed,
      rubricReport.passed ? 'rubric passed' : 'rubric failed',
      rubricReport.metrics.threshold,
      rubricReport.score,
      'rubric-failed'
    );
    for (const violation of rubricReport.violations) {
      violations.push({ ...violation, path: `rubric.${violation.path ?? ''}`.replace(/\.$/, '') });
    }
  }

  const expectedScoreValid = contract.expectedScore === undefined || isValidScore(contract.expectedScore);
  if (!expectedScoreValid) {
    addViolation(
      violations,
      'expected-score-invalid',
      'Expected gold score must be a number between 0 and 100.',
      'gold.expectedScore',
      '0-100',
      contract.expectedScore
    );
  }
  const scorePass =
    actualScore !== undefined &&
    (contract.expectedScore !== undefined
      ? expectedScoreValid && Math.abs(actualScore - contract.expectedScore) <= tolerance
      : actualScore >= threshold);
  check(
    checks,
    violations,
    'score',
    scorePass,
    contract.expectedScore === undefined
      ? `score ${actualScore ?? 0}/100, threshold ${threshold}/100`
      : `score ${actualScore ?? 0}/100, expected ${contract.expectedScore}/100 ± ${tolerance}`,
    contract.expectedScore ?? threshold,
    actualScore,
    'score-contract-failed'
  );

  if (contract.minScore !== undefined) {
    const passed = isValidScore(contract.minScore) && actualScore !== undefined && actualScore >= contract.minScore;
    check(
      checks,
      violations,
      'minScore',
      passed,
      passed ? 'minimum score met' : 'minimum score not met',
      contract.minScore,
      actualScore,
      'minimum-score-failed'
    );
  }
  if (contract.maxScore !== undefined) {
    const passed = isValidScore(contract.maxScore) && actualScore !== undefined && actualScore <= contract.maxScore;
    check(
      checks,
      violations,
      'maxScore',
      passed,
      passed ? 'maximum score respected' : 'maximum score exceeded',
      contract.maxScore,
      actualScore,
      'maximum-score-failed'
    );
  }
  if (contract.expectedFormat !== undefined) {
    const actualFormat = candidate.format ?? candidate.outputFormat;
    check(
      checks,
      violations,
      'format',
      actualFormat === contract.expectedFormat,
      actualFormat === contract.expectedFormat
        ? 'output format matches gold contract'
        : 'output format does not match gold contract',
      contract.expectedFormat,
      actualFormat,
      'format-mismatch'
    );
  }

  evaluateTextContract(candidate, contract, checks, violations);
  evaluateLabelContract(candidate, contract, checks, violations);
  evaluateExpectedRubricScores(candidate, contract, tolerance, checks, violations);

  const score = actualScore ?? 0;
  const passed = violations.length === 0 && Object.values(checks).every((item) => item.passed);
  return {
    id: normalizedId(input.id) || 'subjective-case',
    task: input.task ?? input.kind ?? input.category ?? 'unknown',
    candidateId,
    score,
    passed,
    checks,
    violations,
    metrics: {
      threshold,
      rubricScore: rubricReport?.score
    }
  };
}

export function evaluateSubjectiveGoldSet(input: SubjectiveGoldSet): SubjectiveGoldSetReport {
  const violations: SubjectiveViolation[] = [];
  const threshold = thresholdOrDefault(input.threshold);
  if (!isValidThreshold(input.threshold) && input.threshold !== undefined) {
    addViolation(
      violations,
      'gold-set-threshold-invalid',
      'Gold-set threshold must be a number between 0 and 100.',
      'threshold',
      '0-100',
      input.threshold
    );
  }
  const cases = Array.isArray(input.cases) ? input.cases : [];
  if (cases.length === 0)
    addViolation(
      violations,
      'gold-set-empty',
      'Gold set must contain at least one case.',
      'cases',
      'non-empty',
      cases.length
    );
  const reports = cases.map((subjectiveCase) => evaluateSubjectiveGoldCase(subjectiveCase, threshold));
  const score =
    reports.length === 0 ? 0 : Math.round(reports.reduce((sum, report) => sum + report.score, 0) / reports.length);
  const passedCaseCount = reports.filter((report) => report.passed).length;
  const passed =
    violations.length === 0 && reports.length > 0 && passedCaseCount === reports.length && score >= threshold;
  return {
    id: normalizedId(input.id) || 'subjective-gold-set',
    score,
    passed,
    cases: reports,
    caseReports: reports,
    violations,
    metrics: {
      caseCount: reports.length,
      passedCaseCount,
      failedCaseCount: reports.length - passedCaseCount,
      passRatePercent: reports.length === 0 ? 0 : Math.round((passedCaseCount / reports.length) * 100),
      averageScore: score,
      threshold
    }
  };
}

interface RankingAccumulator {
  points: number;
  comparisonWeight: number;
  wins: number;
  losses: number;
  ties: number;
  comparisons: number;
}

function preferenceValue(
  value: SubjectivePreference | undefined,
  left: string,
  right: string
): SubjectivePreference | undefined {
  const normalized = normalizedId(value);
  if (!normalized) return undefined;
  if (normalized === 'draw') return 'tie';
  if (normalized === 'left') return left;
  if (normalized === 'right') return right;
  return normalized;
}

function validPreference(value: SubjectivePreference | undefined, left: string, right: string): boolean {
  return value === 'tie' || value === left || value === right;
}

function candidateId(reference: SubjectiveCandidateReference): string {
  return typeof reference === 'string' ? normalizedId(reference) : normalizedId(reference?.id);
}

function candidateObject(
  reference: SubjectiveCandidateReference,
  candidates: Map<string, SubjectiveCandidate>
): SubjectiveCandidate {
  if (typeof reference !== 'string') return reference;
  return candidates.get(normalizedId(reference)) ?? { id: normalizedId(reference) };
}

function registerCandidate(
  reference: SubjectiveCandidateReference,
  candidates: Map<string, SubjectiveCandidate>,
  violations: SubjectiveViolation[],
  path: string
): string {
  const id = candidateId(reference);
  if (!id) {
    addViolation(
      violations,
      'candidate-id-missing',
      'Pairwise candidates require a non-empty id.',
      path,
      'non-empty id',
      reference
    );
    return '';
  }
  if (typeof reference !== 'string') {
    if (candidates.has(id)) {
      const existing = candidates.get(id);
      if (existing !== reference)
        addViolation(
          violations,
          'candidate-duplicate',
          `Pairwise candidate '${id}' is duplicated.`,
          path,
          'unique id',
          id
        );
    } else {
      candidates.set(id, reference);
    }
  } else if (!candidates.has(id)) {
    candidates.set(id, { id });
  }
  const candidate = candidates.get(id);
  if (candidate?.score !== undefined && !isValidScore(candidate.score)) {
    addViolation(
      violations,
      'candidate-score-invalid',
      `Candidate '${id}' has an invalid score.`,
      `${path}.score`,
      '0-100',
      candidate.score
    );
  }
  const scores = candidate ? scoreMap(candidate) : undefined;
  if (scores && Object.entries(scores).some(([, score]) => !isValidScore(score))) {
    addViolation(
      violations,
      'candidate-rubric-score-invalid',
      `Candidate '${id}' has an invalid rubric score.`,
      `${path}.rubricScores`,
      'all scores 0-100',
      scores
    );
  }
  return id;
}

function accumulate(
  accumulators: Map<string, RankingAccumulator>,
  left: string,
  right: string,
  preference: SubjectivePreference,
  weight: number
): void {
  const leftAccumulator = accumulators.get(left) ?? {
    points: 0,
    comparisonWeight: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    comparisons: 0
  };
  const rightAccumulator = accumulators.get(right) ?? {
    points: 0,
    comparisonWeight: 0,
    wins: 0,
    losses: 0,
    ties: 0,
    comparisons: 0
  };
  leftAccumulator.comparisonWeight += weight;
  rightAccumulator.comparisonWeight += weight;
  leftAccumulator.comparisons += 1;
  rightAccumulator.comparisons += 1;
  if (preference === 'tie') {
    leftAccumulator.points += weight / 2;
    rightAccumulator.points += weight / 2;
    leftAccumulator.ties += 1;
    rightAccumulator.ties += 1;
  } else if (preference === left) {
    leftAccumulator.points += weight;
    leftAccumulator.wins += 1;
    rightAccumulator.losses += 1;
  } else {
    rightAccumulator.points += weight;
    rightAccumulator.wins += 1;
    leftAccumulator.losses += 1;
  }
  accumulators.set(left, leftAccumulator);
  accumulators.set(right, rightAccumulator);
}

function rankingFrom(
  candidates: Map<string, SubjectiveCandidate>,
  accumulators: Map<string, RankingAccumulator>
): SubjectiveRankingEntry[] {
  return [...candidates.keys()]
    .map((candidateId) => {
      const aggregate = accumulators.get(candidateId) ?? {
        points: 0,
        comparisonWeight: 0,
        wins: 0,
        losses: 0,
        ties: 0,
        comparisons: 0
      };
      const winRate = aggregate.comparisonWeight === 0 ? 0 : aggregate.points / aggregate.comparisonWeight;
      return {
        candidateId,
        rank: 0,
        score: Math.round(winRate * 100),
        points: aggregate.points,
        wins: aggregate.wins,
        losses: aggregate.losses,
        ties: aggregate.ties,
        comparisons: aggregate.comparisons,
        winRate
      };
    })
    .sort((left, right) => {
      if (right.winRate !== left.winRate) return right.winRate - left.winRate;
      const leftCandidate = candidates.get(left.candidateId);
      const rightCandidate = candidates.get(right.candidateId);
      const leftScore = averageCandidateScore(leftCandidate ?? {});
      const rightScore = averageCandidateScore(rightCandidate ?? {});
      if (leftScore !== undefined && rightScore !== undefined && rightScore !== leftScore)
        return rightScore - leftScore;
      if (leftScore !== undefined && rightScore === undefined) return -1;
      if (leftScore === undefined && rightScore !== undefined) return 1;
      return left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0;
    })
    .map((entry, index) => ({ ...entry, rank: index + 1 }));
}

export function evaluateSubjectivePairwise(input: SubjectivePairwiseSet): SubjectivePairwiseReport {
  const violations: SubjectiveViolation[] = [];
  const candidates = new Map<string, SubjectiveCandidate>();
  const expectedAccumulators = new Map<string, RankingAccumulator>();
  const observedAccumulators = new Map<string, RankingAccumulator>();
  const threshold = thresholdOrDefault(input.threshold);
  if (!isValidThreshold(input.threshold) && input.threshold !== undefined) {
    addViolation(
      violations,
      'pairwise-threshold-invalid',
      'Pairwise threshold must be a number between 0 and 100.',
      'threshold',
      '0-100',
      input.threshold
    );
  }
  for (const [index, candidate] of (input.candidates ?? []).entries()) {
    registerCandidate(candidate, candidates, violations, `candidates[${index}]`);
  }
  const comparisons = Array.isArray(input.comparisons) ? input.comparisons : [];
  if (comparisons.length === 0)
    addViolation(
      violations,
      'pairwise-empty',
      'Pairwise set must contain at least one comparison.',
      'comparisons',
      'non-empty',
      comparisons.length
    );

  let totalWeight = 0;
  let correctWeight = 0;
  let validComparisonCount = 0;
  let correctComparisonCount = 0;
  let tieCount = 0;
  const reports: SubjectivePairwiseComparisonReport[] = [];

  for (const [index, comparison] of comparisons.entries()) {
    const path = `comparisons[${index}]`;
    const left = registerCandidate(comparison.left, candidates, violations, `${path}.left`);
    const right = registerCandidate(comparison.right, candidates, violations, `${path}.right`);
    const expected = preferenceValue(
      comparison.expectedPreference ?? comparison.goldPreference ?? comparison.preference,
      left,
      right
    );
    const leftCandidate = candidateObject(comparison.left, candidates);
    const rightCandidate = candidateObject(comparison.right, candidates);
    let observed = preferenceValue(
      comparison.observedPreference ?? comparison.actualPreference ?? comparison.winner,
      left,
      right
    );
    if (observed === undefined) {
      if (input.requireExplicitObservedPreference) {
        addViolation(
          violations,
          'observed-preference-required',
          `Comparison '${comparison.id}' requires an explicit observed preference for human-labelled evaluation.`,
          `${path}.observedPreference`,
          'left id, right id, or tie'
        );
      } else {
        const leftScore = averageCandidateScore(leftCandidate);
        const rightScore = averageCandidateScore(rightCandidate);
        if (leftScore !== undefined && rightScore !== undefined) {
          observed = leftScore === rightScore ? 'tie' : leftScore > rightScore ? left : right;
        } else {
          addViolation(
            violations,
            'observed-preference-missing',
            `Comparison '${comparison.id}' needs an observed preference or deterministic candidate scores.`,
            `${path}.observedPreference`,
            'left id, right id, or tie'
          );
        }
      }
    }
    const validIds = left.length > 0 && right.length > 0 && left !== right;
    if (!validIds) {
      addViolation(
        violations,
        left === right ? 'pairwise-same-candidate' : 'pairwise-candidate-invalid',
        'Pairwise comparison must contain two distinct candidates.',
        path
      );
    }
    const expectedIsValid = validIds && expected !== undefined && validPreference(expected, left, right);
    const observedIsValid = validIds && observed !== undefined && validPreference(observed, left, right);
    if (expected !== undefined && !expectedIsValid) {
      addViolation(
        violations,
        'expected-preference-invalid',
        `Comparison '${comparison.id}' has an invalid expected preference.`,
        `${path}.expectedPreference`,
        [left, right, 'tie'],
        expected
      );
    }
    if (observed !== undefined && !observedIsValid) {
      addViolation(
        violations,
        'observed-preference-invalid',
        `Comparison '${comparison.id}' has an invalid observed preference.`,
        `${path}.observedPreference`,
        [left, right, 'tie'],
        observed
      );
    }
    const rawWeight = comparison.weight ?? 1;
    const validWeight = Number.isFinite(rawWeight) && rawWeight >= 0;
    if (!validWeight) {
      addViolation(
        violations,
        'pairwise-weight-invalid',
        `Comparison '${comparison.id}' has an invalid weight.`,
        `${path}.weight`,
        'finite number >= 0',
        rawWeight
      );
    }
    const weight = validWeight ? rawWeight : 0;
    const validComparison = expectedIsValid && observedIsValid && validWeight;
    const correct = validComparison && expected === observed;
    if (validComparison) {
      validComparisonCount += 1;
      totalWeight += weight;
      if (correct) {
        correctComparisonCount += 1;
        correctWeight += weight;
      }
      if (observed === 'tie') tieCount += 1;
      accumulate(expectedAccumulators, left, right, expected!, weight);
      accumulate(observedAccumulators, left, right, observed!, weight);
    }
    reports.push({
      id: normalizedId(comparison.id) || `comparison-${index + 1}`,
      left,
      right,
      expectedPreference: expected,
      observedPreference: observed,
      weight,
      score: correct ? 100 : 0,
      passed: correct
    });
  }

  if (totalWeight === 0)
    addViolation(
      violations,
      'pairwise-weight-empty',
      'Pairwise set must have positive total comparison weight.',
      'comparisons',
      '> 0',
      totalWeight
    );
  const score = totalWeight === 0 ? 0 : Math.round((correctWeight / totalWeight) * 100);
  const ranking = rankingFrom(candidates, observedAccumulators);
  const expectedRanking = rankingFrom(candidates, expectedAccumulators);
  return {
    id: normalizedId(input.id) || 'subjective-pairwise',
    score,
    passed:
      violations.length === 0 && reports.length > 0 && validComparisonCount === reports.length && score >= threshold,
    comparisons: reports,
    ranking,
    expectedRanking,
    violations,
    metrics: {
      comparisonCount: reports.length,
      validComparisonCount,
      correctComparisonCount,
      accuracyPercent: score,
      tieCount,
      candidateCount: candidates.size,
      threshold
    }
  };
}

export const evaluateGoldSet = evaluateSubjectiveGoldSet;
export const evaluatePairwise = evaluateSubjectivePairwise;
export const evaluateRubric = evaluateSubjectiveRubric;
export const scoreSubjectiveRubric = evaluateSubjectiveRubric;

export class SubjectiveGoldSetEvaluator {
  public evaluate(input: SubjectiveGoldSet): SubjectiveGoldSetReport {
    return evaluateSubjectiveGoldSet(input);
  }
}

export class SubjectivePairwiseEvaluator {
  public evaluate(input: SubjectivePairwiseSet): SubjectivePairwiseReport {
    return evaluateSubjectivePairwise(input);
  }
}

export class SubjectiveRubricEvaluator {
  public evaluate(input: SubjectiveRubricEvaluationInput): SubjectiveRubricReport {
    return evaluateSubjectiveRubric(input);
  }
}
