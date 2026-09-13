#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PHASE18_23_SCHEMA_VERSION = 1;
export const PHASE18_23_KIND = 'phase18-23-evidence';
export const REAL_PROVIDER_MARKER = 'INKPI_REAL_PROVIDER_ACCEPTANCE_OK';
export const REQUIRED_CHAPTER_COUNTS = Object.freeze([100, 300]);

/**
 * Keep this list in sync with scripts/final-freeze-audit.mjs without importing
 * packages or treating a local test result as a production assertion.
 */
export const FINAL_FREEZE_GROUPS = Object.freeze([
  ['semantic-content', 'Canonical content and source maps'],
  ['story-model', 'Canonical StoryState and provenance'],
  ['vertical-slices', 'Five Desktop to Daemon vertical slices'],
  ['projection-sync', 'Domain projection and cross-device sync'],
  ['proposal-cas', 'Proposal, CAS commit, and undo'],
  ['durable-execution', 'Crash recovery and durable execution'],
  ['context-pipeline', 'Context registration, budget, and fingerprint'],
  ['skills', 'First-party skill lazy loading and activation'],
  ['artifacts', 'Artifact store, lineage, and ownership'],
  ['cache', 'Three-layer cache and invalidation metrics'],
  ['capability-routing', 'Capability-aware provider routing'],
  ['instruction-registry', 'Desktop and Daemon instruction registry'],
  ['evals', 'Objective, subjective, mutation, and long-context evals'],
  ['observability', 'Observability, sampling, and privacy boundary'],
  ['plugins-legacy', '44-plugin migration and legacy cleanup'],
  ['reliability', 'Offline, failure, and unavailable-model drills']
].map(([id, label]) => Object.freeze({ id, label })));

const SENSITIVE_FIELD_NAMES = new Set([
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
  'analysistrace',
  'hiddenthoughts'
]);

const VALID_GROUP_STATUSES = new Set(['passed', 'failed', 'pending', 'missing']);
const PRIVATE_REASONING_PATTERN = /<think>[\s\S]*?<\/think>/gi;
const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:AIza|xox[baprs]-)[A-Za-z0-9_-]{10,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi,
  /\b(?:api[_-]?key|access[_-]?token|authorization|password|secret)\s*[:=]\s*[^,\s]+/gi
];

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function nonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function validTimestamp(value) {
  return nonEmptyString(value) && Number.isFinite(Date.parse(value));
}

function normalizedFieldName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sensitiveFieldName(value) {
  const normalized = normalizedFieldName(value);
  return (
    SENSITIVE_FIELD_NAMES.has(normalized) ||
    normalized.includes('apikey') ||
    normalized.includes('accesstoken') ||
    normalized.includes('authorization') ||
    normalized.includes('bearertoken') ||
    normalized.includes('privatekey') ||
    normalized.includes('chainofthought') ||
    normalized.includes('reasoningtrace') ||
    normalized.includes('hiddenthought')
  );
}

function containsSensitiveField(value, seen = new Set()) {
  if (!isRecord(value) && !Array.isArray(value)) return false;
  const object = value;
  if (seen.has(object)) return false;
  seen.add(object);
  if (Array.isArray(value)) return value.some((child) => containsSensitiveField(child, seen));
  return Object.entries(value).some(
    ([key, child]) => sensitiveFieldName(key) || containsSensitiveField(child, seen)
  );
}

function redactString(value) {
  let result = value.replace(PRIVATE_REASONING_PATTERN, '');
  for (const pattern of SECRET_VALUE_PATTERNS) result = result.replace(pattern, '[redacted]');
  return result;
}

function safeDescriptor(value, maxLength = 160) {
  if (!nonEmptyString(value)) return undefined;
  const oneLine = redactString(value.trim().replace(/[\r\n\t]+/g, ' '));
  return oneLine.length > maxLength ? `${oneLine.slice(0, maxLength)}…` : oneLine;
}

function safeFileRef(value) {
  if (!nonEmptyString(value)) return undefined;
  const normalized = value.replaceAll('\\', '/');
  return safeDescriptor(basename(normalized));
}

function issue(issues, code) {
  if (!issues.some((entry) => entry.code === code)) {
    issues.push({ code, message: 'Evidence is incomplete or not independently attestable.' });
  }
}

function statusFor(present, valid) {
  if (!present) return 'missing';
  return valid ? 'passed' : 'pending';
}

function stableSerialize(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableSerialize(entry, seen)).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => {
      const child = sensitiveFieldName(key) ? '[redacted]' : value[key];
      return `${JSON.stringify(key)}:${stableSerialize(child, seen)}`;
    })
    .join(',')}}`;
}

function digest(value) {
  return createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function safeDigest(value) {
  return digest(value);
}

function pickFirst(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function parseChapterCount(value) {
  if (value === 100 || value === 300) return value;
  if (typeof value !== 'string') return undefined;
  const match = value.match(/(?:^|[^\d])(100|300)(?:[^\d]|$)/);
  return match ? Number(match[1]) : undefined;
}

function chapterNumbersAreComplete(chapters, count) {
  if (!Array.isArray(chapters) || chapters.length !== count) return false;
  return chapters.every((chapter, index) => {
    return isRecord(chapter) && chapter.chapter === index + 1 && nonEmptyString(chapter.text);
  });
}

function hasChapterInputShape(value) {
  return (
    isRecord(value) &&
    (Array.isArray(value.benchmarks) ||
      Array.isArray(value.chapters) ||
      Array.isArray(value.chapters100) ||
      Array.isArray(value.chapters300) ||
      isRecord(value.chapterInput))
  );
}

function extractChapterBenchmarks(input) {
  if (Array.isArray(input)) return input;
  if (!isRecord(input)) return [];
  if (Array.isArray(input.benchmarks)) return input.benchmarks;
  if (Array.isArray(input.chapters)) return [input];
  const benchmarks = [];
  if (Array.isArray(input.chapters100)) benchmarks.push({ chapterCount: 100, chapters: input.chapters100 });
  if (Array.isArray(input.chapters300)) benchmarks.push({ chapterCount: 300, chapters: input.chapters300 });
  return benchmarks;
}

function chapterSourceRef(input, benchmark) {
  return (
    safeFileRef(benchmark?.filePath) ??
    safeFileRef(benchmark?.sourceFile) ??
    safeFileRef(input?.filePath) ??
    safeFileRef(input?.sourceFile) ??
    safeDescriptor(benchmark?.sourceRef) ??
    safeDescriptor(input?.sourceRef) ??
    safeDescriptor(benchmark?.id) ??
    'provided-chapter-input'
  );
}

function normalizeChapterInput(input, issues) {
  const present = input !== undefined && input !== null;
  const rawBenchmarks = extractChapterBenchmarks(input);
  const byCount = new Map();
  const inputSensitive = containsSensitiveField(input);
  if (!present) {
    issue(issues, 'chapter-input-missing');
  } else if (rawBenchmarks.length === 0) {
    issue(issues, 'chapter-input-invalid');
  }
  if (inputSensitive) issue(issues, 'chapter-input-sensitive-field');

  for (const benchmark of rawBenchmarks) {
    if (!isRecord(benchmark)) {
      issue(issues, 'chapter-benchmark-invalid');
      continue;
    }
    const count = parseChapterCount(benchmark.chapterCount) ?? parseChapterCount(benchmark.id);
    if (!REQUIRED_CHAPTER_COUNTS.includes(count)) {
      issue(issues, 'chapter-count-invalid');
      continue;
    }
    if (byCount.has(count)) {
      issue(issues, `chapter-${count}-duplicate`);
      continue;
    }
    const chapters = benchmark.chapters;
    const mode = pickFirst(benchmark.mode, input?.mode);
    const valid =
      mode === 'real-provider' &&
      chapterNumbersAreComplete(chapters, count) &&
      !containsSensitiveField(benchmark) &&
      !inputSensitive;
    if (mode !== 'real-provider') issue(issues, `chapter-${count}-real-mode-required`);
    if (!chapterNumbersAreComplete(chapters, count)) issue(issues, `chapter-${count}-invalid`);
    if (containsSensitiveField(benchmark) || inputSensitive) issue(issues, `chapter-${count}-sensitive-field`);
    const safe = {
      chapterCount: count,
      status: statusFor(true, valid),
      chapterCountVerified: chapterNumbersAreComplete(chapters, count),
      sourceRef: chapterSourceRef(input, benchmark),
      ...(valid ? { inputDigest: safeDigest({ chapterCount: count, chapters }) } : {}),
      ...(isRecord(benchmark.responseContract)
        ? { responseContractPresent: true }
        : { responseContractPresent: false })
    };
    byCount.set(count, { benchmark, chapters, summary: safe, valid });
  }

  for (const count of REQUIRED_CHAPTER_COUNTS) {
    if (!byCount.has(count)) {
      issue(issues, `chapter-${count}-missing`);
      byCount.set(count, {
        benchmark: undefined,
        chapters: [],
        valid: false,
        summary: { chapterCount: count, status: 'missing', chapterCountVerified: false }
      });
    }
  }

  const summaries = REQUIRED_CHAPTER_COUNTS.map((count) => byCount.get(count).summary);
  return {
    status: summaries.every((entry) => entry.status === 'passed') ? 'passed' : present ? 'pending' : 'missing',
    benchmarks: byCount,
    summaries,
    digest: present ? safeDigest(input) : undefined
  };
}

function getContract(benchmark, providerResult) {
  const contract = pickFirst(
    benchmark?.responseContract,
    providerResult?.responseContract,
    providerResult?.contract
  );
  if (!isRecord(contract)) return undefined;
  const anchors = contract.expectedRetrievedAnchors;
  const recoveredChapter = contract.expectedRecoveredChapter;
  if (!Array.isArray(anchors) || anchors.length === 0 || anchors.some((entry) => !positiveInteger(entry))) {
    return undefined;
  }
  if (!positiveInteger(recoveredChapter)) return undefined;
  return { expectedRetrievedAnchors: anchors, expectedRecoveredChapter: recoveredChapter };
}

function extractProviderRuns(input) {
  if (Array.isArray(input)) return input;
  if (!isRecord(input)) return [];
  if (Array.isArray(input.results)) return input.results;
  if (Array.isArray(input.runs)) return input.runs;
  if (Array.isArray(input.benchmarks)) return input.benchmarks;
  if (isRecord(input.results)) {
    return Object.entries(input.results).map(([chapterCount, result]) => ({ chapterCount: Number(chapterCount), result }));
  }
  if (isRecord(input.benchmarks)) {
    return Object.entries(input.benchmarks).map(([chapterCount, result]) => ({ chapterCount: Number(chapterCount), result }));
  }
  if (isRecord(input.longContext) && Array.isArray(input.longContext.reports)) return input.longContext.reports;
  return [];
}

function parseStructuredProviderResponse(value) {
  if (isRecord(value)) {
    const nested = isRecord(value.data) ? value.data : value;
    return {
      marker: nested.marker,
      retrievedAnchors: nested.retrievedAnchors,
      recoveredChapter: nested.recoveredChapter,
      structured: true
    };
  }
  if (typeof value !== 'string') return undefined;
  const text = redactString(value);
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    return parseStructuredProviderResponse(JSON.parse(text.slice(start, end + 1)));
  } catch {
    return undefined;
  }
}

function reportHasProviderGates(value) {
  if (!isRecord(value)) return false;
  const gates = isRecord(value.gates) ? value.gates : {};
  const provider = isRecord(value.provider) ? value.provider : {};
  return (
    value.passed === true &&
    (gates.providerResponse === true || provider.responseContainsMarker === true) &&
    (gates.structuredOutput === true || provider.structuredOutput === true) &&
    (gates.providerRecovery === true || positiveInteger(provider.recoveredChapter))
  );
}

function validateProviderRun(run, inherited, chapterEntry, issues, index) {
  const value = isRecord(run) ? run : {};
  const result = isRecord(value.result) ? value.result : value;
  const realSource =
    pickFirst(value.mode, value.source, inherited.mode, inherited.source) === 'real-provider' ||
    value.real === true ||
    inherited.real === true;
  const chapterCount =
    parseChapterCount(value.chapterCount) ??
    parseChapterCount(value.benchmarkChapterCount) ??
    parseChapterCount(value.id) ??
    (isRecord(value.metrics) ? parseChapterCount(value.metrics.chapterCount) : undefined);
  const reportedProvider = isRecord(result.provider) ? result.provider.provider : undefined;
  const reportedModel = isRecord(result.provider) ? result.provider.model : undefined;
  const provider = safeDescriptor(pickFirst(value.provider, inherited.provider, value.providerName, reportedProvider));
  const model = safeDescriptor(pickFirst(value.model, inherited.model, reportedModel));
  const runId = safeDescriptor(pickFirst(value.runId, value.requestId, value.executionId, inherited.runId));
  const recordedAt = pickFirst(value.recordedAt, value.observedAt, value.capturedAt, inherited.recordedAt);
  const localOrFixtureProvider = localOrFixtureSource(value) || localOrFixtureSource(inherited);
  const success = result.success === true || result.passed === true || reportHasProviderGates(result);
  const reportSummary = reportHasProviderGates(result);
  const responseValue = pickFirst(result.response, result.output, result.content, result.providerResponse);
  const response = parseStructuredProviderResponse(responseValue);
  const contract = getContract(chapterEntry?.benchmark, value);
  const contractWithinBenchmark =
    contract !== undefined &&
    chapterCount > 0 &&
    contract.expectedRetrievedAnchors.every((entry) => entry <= chapterCount) &&
    contract.expectedRecoveredChapter <= chapterCount;
  const reportContractAvailable = reportSummary && isRecord(result.metrics);
  const expectedAnchors = contract?.expectedRetrievedAnchors ?? [];
  const anchors = Array.isArray(response?.retrievedAnchors) ? response.retrievedAnchors : [];
  const recoveredChapter = response?.recoveredChapter;
  const markerOk = response?.marker === REAL_PROVIDER_MARKER ||
    (reportSummary && result.provider?.responseContainsMarker === true);
  const structuredOk = response?.structured === true || reportSummary;
  const anchorShapeOk = anchors.length > 0 && anchors.every((entry) => positiveInteger(entry));
  const recoveryShapeOk = positiveInteger(recoveredChapter);
  const contractOk =
    reportContractAvailable ||
    (contractWithinBenchmark &&
      expectedAnchors.every((entry) => anchors.includes(entry)) &&
      recoveredChapter === contract.expectedRecoveredChapter);
  const sensitive = containsSensitiveField(value) || containsSensitiveField(inherited);
  const valid =
    realSource &&
    chapterEntry?.valid === true &&
    REQUIRED_CHAPTER_COUNTS.includes(chapterCount) &&
    !localOrFixtureProvider &&
    nonEmptyString(provider) &&
    nonEmptyString(model) &&
    nonEmptyString(runId) &&
    validTimestamp(recordedAt) &&
    success &&
    markerOk &&
    structuredOk &&
    (reportSummary || (anchorShapeOk && recoveryShapeOk)) &&
    contractOk &&
    !sensitive;

  if (!realSource) issue(issues, `provider-${index}-real-source-required`);
  if (localOrFixtureProvider) issue(issues, `provider-${index}-local-or-fixture`);
  if (!REQUIRED_CHAPTER_COUNTS.includes(chapterCount)) issue(issues, `provider-${index}-chapter-count-invalid`);
  if (!nonEmptyString(provider) || !nonEmptyString(model)) issue(issues, `provider-${index}-identity-missing`);
  if (!nonEmptyString(runId) || !validTimestamp(recordedAt)) issue(issues, `provider-${index}-metadata-missing`);
  if (!success) issue(issues, `provider-${index}-result-not-successful`);
  if (!markerOk || !structuredOk || (!reportSummary && (!anchorShapeOk || !recoveryShapeOk))) {
    issue(issues, `provider-${index}-response-invalid`);
  }
  if (!contractOk) issue(issues, `provider-${index}-response-contract-missing-or-mismatch`);
  if (sensitive) issue(issues, `provider-${index}-sensitive-field`);

  return {
    chapterCount,
    valid,
    summary: {
      chapterCount: chapterCount ?? null,
      status: statusFor(true, valid),
      provider: provider ?? 'unidentified-provider',
      model: model ?? 'unidentified-model',
      ...(runId ? { runId } : {}),
      ...(validTimestamp(recordedAt) ? { recordedAt } : {}),
      response: {
        success,
        markerVerified: markerOk,
        structuredVerified: structuredOk,
        retrievedAnchorCount: anchors.length || (reportSummary ? Number(result.provider?.retrievedAnchorCount) || 0 : 0),
        ...(recoveredChapter !== undefined
          ? { recoveredChapter }
          : reportSummary && positiveInteger(result.provider?.recoveredChapter)
            ? { recoveredChapter: result.provider.recoveredChapter }
            : {})
      },
      ...(nonNegativeNumber(result.durationMs) ? { durationMs: result.durationMs } : {}),
      resultDigest: safeDigest(value)
    }
  };
}

function normalizeProviderResults(input, chapterData, issues) {
  const present = input !== undefined && input !== null;
  const inherited = isRecord(input) ? input : {};
  const runs = extractProviderRuns(input);
  const byCount = new Map();
  if (!present) issue(issues, 'provider-results-missing');
  if (present && runs.length === 0) issue(issues, 'provider-results-invalid');
  if (present && containsSensitiveField(input)) issue(issues, 'provider-results-sensitive-field');

  runs.forEach((run, index) => {
    const count =
      parseChapterCount(run?.chapterCount) ??
      parseChapterCount(run?.id) ??
      (isRecord(run?.metrics) ? parseChapterCount(run.metrics.chapterCount) : undefined);
    const entry = REQUIRED_CHAPTER_COUNTS.includes(count) ? chapterData.benchmarks.get(count) : undefined;
    const validated = validateProviderRun(run, inherited, entry, issues, index);
    if (!REQUIRED_CHAPTER_COUNTS.includes(validated.chapterCount)) return;
    if (byCount.has(validated.chapterCount)) {
      issue(issues, `provider-${validated.chapterCount}-duplicate`);
      return;
    }
    byCount.set(validated.chapterCount, validated);
  });

  for (const count of REQUIRED_CHAPTER_COUNTS) {
    if (!byCount.has(count)) {
      issue(issues, `provider-${count}-missing`);
      byCount.set(count, {
        chapterCount: count,
        valid: false,
        summary: { chapterCount: count, status: 'missing' }
      });
    }
  }

  const summaries = REQUIRED_CHAPTER_COUNTS.map((count) => byCount.get(count).summary);
  return {
    status: summaries.every((entry) => entry.status === 'passed') ? 'passed' : present ? 'pending' : 'missing',
    benchmarks: byCount,
    summaries,
    digest: present ? safeDigest(input) : undefined
  };
}

function extractGoldAndPairwise(input) {
  if (!isRecord(input)) return { goldSet: undefined, pairwise: undefined };
  const goldSet = pickFirst(input.goldSet, input.humanGold, input.gold);
  const pairwise = pickFirst(input.pairwise, input.pairwiseSet, input.humanPairwise);
  if (goldSet !== undefined || pairwise !== undefined) return { goldSet, pairwise };
  return {
    goldSet: Array.isArray(input.cases) || Array.isArray(input.annotations) ? input : undefined,
    pairwise: undefined
  };
}

function validateProvenance(provenance, issues, prefix) {
  if (!isRecord(provenance)) {
    issue(issues, `${prefix}-provenance-missing`);
    return { valid: false, annotatorIds: [], recordedAt: undefined, datasetId: undefined, version: undefined };
  }
  const sourceOk = provenance.source === 'human-labelled';
  const datasetId = safeDescriptor(provenance.datasetId);
  const version = safeDescriptor(provenance.version);
  const recordedAt = provenance.annotatedAt;
  const rawAnnotatorIds = provenance.annotatorIds;
  const annotatorIds = Array.isArray(rawAnnotatorIds)
    ? provenance.annotatorIds.filter(nonEmptyString).map((entry) => entry.trim())
    : [];
  const annotatorsShapeOk = Array.isArray(rawAnnotatorIds) && rawAnnotatorIds.length === annotatorIds.length;
  const annotatorsUnique = new Set(annotatorIds).size === annotatorIds.length;
  const annotationCount = provenance.annotationCount;
  const adjudication = provenance.adjudication;
  const adjudicationOk =
    isRecord(adjudication) &&
    (adjudication.status === 'not-required'
      ? nonEmptyString(adjudication.reason)
      : adjudication.status === 'complete' &&
        nonEmptyString(adjudication.adjudicatorId) &&
        ['accepted', 'revised', 'rejected'].includes(adjudication.decision));
  if (!sourceOk) issue(issues, `${prefix}-source-not-human-labelled`);
  if (!datasetId || !version) issue(issues, `${prefix}-provenance-identity-missing`);
  if (!validTimestamp(recordedAt)) issue(issues, `${prefix}-timestamp-invalid`);
  if (annotatorIds.length === 0 || !annotatorsShapeOk || !annotatorsUnique) issue(issues, `${prefix}-annotators-invalid`);
  if (!positiveInteger(annotationCount)) issue(issues, `${prefix}-annotation-count-invalid`);
  if (!adjudicationOk) issue(issues, `${prefix}-adjudication-invalid`);
  return {
    valid:
      sourceOk &&
      Boolean(datasetId && version) &&
      validTimestamp(recordedAt) &&
      annotatorIds.length > 0 &&
      annotatorsShapeOk &&
      annotatorsUnique &&
      positiveInteger(annotationCount) &&
      adjudicationOk,
    annotatorIds,
    recordedAt: validTimestamp(recordedAt) ? recordedAt : undefined,
    datasetId,
    version,
    annotationCount
  };
}

function validateGoldSet(goldSet, issues) {
  const prefix = 'human-gold';
  if (!isRecord(goldSet)) {
    issue(issues, 'human-gold-missing');
    return { valid: false, summary: { status: 'missing', caseCount: 0, annotationCount: 0 } };
  }
  const provenance = validateProvenance(goldSet.provenance, issues, prefix);
  const cases = Array.isArray(goldSet.cases) ? goldSet.cases : [];
  const annotations = Array.isArray(goldSet.annotations) ? goldSet.annotations : [];
  const caseIds = new Set();
  let casesValid = cases.length > 0;
  let rubricCaseCount = 0;
  for (const entry of cases) {
    const id = isRecord(entry) && nonEmptyString(entry.id) ? entry.id.trim() : '';
    if (!id || caseIds.has(id)) casesValid = false;
    if (id) caseIds.add(id);
    if (isRecord(entry) && isRecord(entry.gold) && isRecord(entry.gold.rubric)) rubricCaseCount += 1;
  }
  if (!casesValid) issue(issues, 'human-gold-cases-invalid');
  if (rubricCaseCount === 0) issue(issues, 'human-gold-rubric-missing');
  const covered = new Set();
  const annotatorIds = new Set(provenance.annotatorIds);
  let annotationsValid = annotations.length > 0;
  for (const annotation of annotations) {
    if (!isRecord(annotation)) {
      annotationsValid = false;
      continue;
    }
    const caseId = annotation.caseId;
    const annotatorId = annotation.annotatorId;
    if (!nonEmptyString(caseId) || !caseIds.has(caseId)) annotationsValid = false;
    else covered.add(caseId);
    if (!nonEmptyString(annotatorId) || !annotatorIds.has(annotatorId)) annotationsValid = false;
    if (!nonEmptyString(annotation.label)) annotationsValid = false;
  }
  if (covered.size !== caseIds.size) annotationsValid = false;
  if (!annotationsValid) issue(issues, 'human-gold-annotations-invalid');
  if (provenance.annotationCount !== annotations.length) issue(issues, 'human-gold-count-mismatch');
  const valid = provenance.valid && casesValid && annotationsValid && rubricCaseCount > 0;
  return {
    valid,
    summary: {
      status: statusFor(true, valid),
      datasetId: provenance.datasetId,
      version: provenance.version,
      ...(provenance.recordedAt ? { annotatedAt: provenance.recordedAt } : {}),
      annotatorCount: provenance.annotatorIds.length,
      caseCount: cases.length,
      annotationCount: annotations.length,
      rubricCaseCount,
      digest: safeDigest(goldSet)
    }
  };
}

function preferenceIsExplicit(comparison) {
  return isRecord(comparison) &&
    nonEmptyString(pickFirst(comparison.observedPreference, comparison.actualPreference, comparison.winner));
}

function validatePairwiseSet(pairwise, issues) {
  const prefix = 'human-pairwise';
  if (!isRecord(pairwise)) {
    issue(issues, 'human-pairwise-missing');
    return { valid: false, summary: { status: 'missing', comparisonCount: 0, annotationCount: 0 } };
  }
  const provenance = validateProvenance(pairwise.provenance, issues, prefix);
  const comparisons = Array.isArray(pairwise.comparisons) ? pairwise.comparisons : [];
  const annotations = Array.isArray(pairwise.annotations) ? pairwise.annotations : [];
  const comparisonIds = new Set();
  let comparisonsValid = comparisons.length > 0;
  for (const comparison of comparisons) {
    const id = isRecord(comparison) && nonEmptyString(comparison.id) ? comparison.id.trim() : '';
    const left = isRecord(comparison) ? comparison.left : undefined;
    const right = isRecord(comparison) ? comparison.right : undefined;
    if (!id || comparisonIds.has(id) || !nonEmptyString(left) || !nonEmptyString(right) || left === right) {
      comparisonsValid = false;
    }
    if (id) comparisonIds.add(id);
    if (!preferenceIsExplicit(comparison)) comparisonsValid = false;
  }
  if (pairwise.requireExplicitObservedPreference !== true) comparisonsValid = false;
  if (!comparisonsValid) issue(issues, 'human-pairwise-comparisons-invalid');
  const annotatorIds = new Set(provenance.annotatorIds);
  const covered = new Set();
  let annotationsValid = annotations.length > 0;
  for (const annotation of annotations) {
    if (!isRecord(annotation)) {
      annotationsValid = false;
      continue;
    }
    if (!nonEmptyString(annotation.comparisonId) || !comparisonIds.has(annotation.comparisonId)) annotationsValid = false;
    else covered.add(annotation.comparisonId);
    if (!nonEmptyString(annotation.annotatorId) || !annotatorIds.has(annotation.annotatorId)) annotationsValid = false;
    if (!nonEmptyString(annotation.preference)) annotationsValid = false;
  }
  if (covered.size !== comparisonIds.size) annotationsValid = false;
  if (!annotationsValid) issue(issues, 'human-pairwise-annotations-invalid');
  if (provenance.annotationCount !== annotations.length) issue(issues, 'human-pairwise-count-mismatch');
  const valid = provenance.valid && comparisonsValid && annotationsValid;
  return {
    valid,
    summary: {
      status: statusFor(true, valid),
      datasetId: provenance.datasetId,
      version: provenance.version,
      ...(provenance.recordedAt ? { annotatedAt: provenance.recordedAt } : {}),
      annotatorCount: provenance.annotatorIds.length,
      comparisonCount: comparisons.length,
      annotationCount: annotations.length,
      digest: safeDigest(pairwise)
    }
  };
}

function normalizeHumanLabels(input, issues) {
  const present = input !== undefined && input !== null;
  if (!present) {
    issue(issues, 'human-labels-missing');
    return { status: 'missing', gold: validateGoldSet(undefined, issues), pairwise: validatePairwiseSet(undefined, issues) };
  }
  const inputSensitive = containsSensitiveField(input);
  if (inputSensitive) issue(issues, 'human-labels-sensitive-field');
  const { goldSet, pairwise } = extractGoldAndPairwise(input);
  const gold = validateGoldSet(goldSet, issues);
  const pairwiseReport = validatePairwiseSet(pairwise, issues);
  return {
    status: gold.valid && pairwiseReport.valid && !inputSensitive ? 'passed' : 'pending',
    gold: gold.summary,
    pairwise: pairwiseReport.summary,
    digest: safeDigest(input)
  };
}

function extractRuntimeEntries(input, chapterData) {
  if (Array.isArray(input)) return input;
  if (isRecord(input) && Array.isArray(input.benchmarks)) return input.benchmarks;
  const entries = [];
  for (const count of REQUIRED_CHAPTER_COUNTS) {
    const chapterEntry = chapterData.benchmarks.get(count);
    if (chapterEntry?.benchmark?.observations) {
      entries.push({ chapterCount: count, observations: chapterEntry.benchmark.observations });
    }
  }
  if (entries.length > 0) return entries;
  if (isRecord(input) && isRecord(input.observations)) return [input];
  return [];
}

function validateRuntimeEntry(entry, inherited, chapterData, issues, index) {
  const value = isRecord(entry) ? entry : {};
  const observations = isRecord(value.observations) ? value.observations : value;
  const chapterCount = parseChapterCount(value.chapterCount) ?? parseChapterCount(value.id);
  const chapterEntry = chapterData.benchmarks.get(chapterCount);
  const source = pickFirst(observations.source, value.source, inherited.source);
  const runId = safeDescriptor(pickFirst(observations.runId, value.runId, inherited.runId));
  const retained = observations.retainedChapters;
  const cacheLookups = observations.cacheLookups;
  const recovery = observations.recovery;
  const validRetained =
    Array.isArray(retained) &&
    retained.length > 0 &&
    retained.every((chapter) => positiveInteger(chapter) && chapter <= chapterCount);
  const validCache =
    Array.isArray(cacheLookups) &&
    cacheLookups.length > 0 &&
    cacheLookups.every((lookup) => isRecord(lookup) && nonEmptyString(lookup.key) && typeof lookup.hit === 'boolean');
  const validRecovery =
    isRecord(recovery) &&
    recovery.attempted === true &&
    positiveInteger(recovery.recoveredChapter) &&
    recovery.recoveredChapter <= chapterCount;
  const valid =
    chapterEntry?.valid === true &&
    REQUIRED_CHAPTER_COUNTS.includes(chapterCount) &&
    source === 'runtime' &&
    nonEmptyString(runId) &&
    validRetained &&
    validCache &&
    validRecovery &&
    !containsSensitiveField(entry);
  if (source !== 'runtime') issue(issues, `runtime-${index}-runtime-source-required`);
  if (!REQUIRED_CHAPTER_COUNTS.includes(chapterCount)) issue(issues, `runtime-${index}-chapter-count-invalid`);
  if (!nonEmptyString(runId)) issue(issues, `runtime-${index}-run-id-missing`);
  if (!validRetained) issue(issues, `runtime-${index}-retained-chapters-invalid`);
  if (!validCache) issue(issues, `runtime-${index}-cache-lookups-invalid`);
  if (!validRecovery) issue(issues, `runtime-${index}-recovery-invalid`);
  if (containsSensitiveField(entry)) issue(issues, `runtime-${index}-sensitive-field`);
  return {
    chapterCount,
    valid,
    summary: {
      chapterCount: chapterCount ?? null,
      status: statusFor(true, valid),
      ...(runId ? { runId } : {}),
      retainedChapterCount: Array.isArray(retained) ? retained.length : 0,
      cacheLookupCount: Array.isArray(cacheLookups) ? cacheLookups.length : 0,
      ...(validRecovery ? { recoveredChapter: recovery.recoveredChapter } : {}),
      observationDigest: safeDigest(entry)
    }
  };
}

function normalizeRuntimeObservations(input, chapterData, issues) {
  const present = input !== undefined && input !== null || REQUIRED_CHAPTER_COUNTS.some((count) => {
    return Boolean(chapterData.benchmarks.get(count)?.benchmark?.observations);
  });
  const inherited = isRecord(input) ? input : {};
  const entries = extractRuntimeEntries(input, chapterData);
  const byCount = new Map();
  if (!present) issue(issues, 'runtime-observations-missing');
  if (present && entries.length === 0) issue(issues, 'runtime-observations-invalid');
  if (present && containsSensitiveField(input)) issue(issues, 'runtime-observations-sensitive-field');
  entries.forEach((entry, index) => {
    const result = validateRuntimeEntry(entry, inherited, chapterData, issues, index);
    if (!REQUIRED_CHAPTER_COUNTS.includes(result.chapterCount)) return;
    if (byCount.has(result.chapterCount)) {
      issue(issues, `runtime-${result.chapterCount}-duplicate`);
      return;
    }
    byCount.set(result.chapterCount, result);
  });
  for (const count of REQUIRED_CHAPTER_COUNTS) {
    if (!byCount.has(count)) {
      issue(issues, `runtime-${count}-missing`);
      byCount.set(count, { chapterCount: count, valid: false, summary: { chapterCount: count, status: 'missing' } });
    }
  }
  const summaries = REQUIRED_CHAPTER_COUNTS.map((count) => byCount.get(count).summary);
  return {
    status: summaries.every((entry) => entry.status === 'passed') ? 'passed' : present ? 'pending' : 'missing',
    benchmarks: byCount,
    summaries,
    digest: present ? safeDigest(input ?? REQUIRED_CHAPTER_COUNTS.map((count) => chapterData.benchmarks.get(count)?.benchmark?.observations)) : undefined
  };
}

function signalRef(value) {
  if (!isRecord(value)) return undefined;
  return safeDescriptor(pickFirst(value.evidenceRef, value.sourceRef, value.source, value.recordedBy));
}

function signalTimestamp(value, fallback) {
  const recordedAt = pickFirst(value?.recordedAt, value?.observedAt, value?.capturedAt, fallback);
  return validTimestamp(recordedAt) ? recordedAt : undefined;
}

function normalizeSignal(kind, value, fallbackTimestamp, issues) {
  const present = value !== undefined && value !== null;
  if (!present) {
    issue(issues, `${kind}-observation-missing`);
    return { status: 'missing', observed: false };
  }
  const record = isRecord(value) ? value : {};
  const sourceRef = signalRef(record);
  const recordedAt = signalTimestamp(record, fallbackTimestamp);
  const observed = record.observed === true;
  const localOrFixture = localOrFixtureSource(record);
  let specific = observed && Boolean(sourceRef) && Boolean(recordedAt) && !localOrFixture;
  const summary = { status: 'pending', observed: false, ...(sourceRef ? { sourceRef } : {}), ...(recordedAt ? { recordedAt } : {}) };
  if (kind === 'dual-instance') {
    const instanceIds = Array.isArray(record.instanceIds)
      ? record.instanceIds.filter(nonEmptyString).map((entry) => entry.trim())
      : [];
    const distinct = new Set(instanceIds).size;
    const instanceCount = positiveInteger(record.instanceCount) ? record.instanceCount : distinct;
    specific = specific && ((distinct >= 2) || instanceCount >= 2);
    summary.instanceCount = Math.max(distinct, instanceCount);
  } else if (kind === 'observability') {
    const sampleCount = positiveInteger(record.sampleCount) ? record.sampleCount : 0;
    const privacyProven = record.redacted === true || record.rawContentAbsent === true || record.noRawCot === true;
    specific = specific && sampleCount > 0 && privacyProven && !containsSensitiveField(record);
    summary.sampleCount = sampleCount;
    summary.privacyBoundaryVerified = privacyProven && !containsSensitiveField(record);
  }
  if (!specific) issue(issues, `${kind}-observation-incomplete`);
  if (localOrFixture) issue(issues, `${kind}-observation-local-or-fixture`);
  summary.status = statusFor(true, specific);
  summary.observed = specific;
  return summary;
}

function normalizeRunMetadata(input, issues) {
  const present = input !== undefined && input !== null;
  if (!present) {
    issue(issues, 'run-metadata-missing');
    return { status: 'missing' };
  }
  const value = isRecord(input) ? input : {};
  const runId = safeDescriptor(pickFirst(value.runId, value.executionRunId, value.id));
  const capturedAt = pickFirst(value.capturedAt, value.recordedAt, value.startedAt);
  const producer = safeDescriptor(pickFirst(value.producer, value.tool, value.harness));
  const sourceRef = safeDescriptor(pickFirst(value.sourceRef, value.evidenceRef, value.source));
  const valid =
    nonEmptyString(runId) &&
    validTimestamp(capturedAt) &&
    !localOrFixtureSource(value) &&
    !containsSensitiveField(value);
  if (!nonEmptyString(runId)) issue(issues, 'run-metadata-run-id-missing');
  if (!validTimestamp(capturedAt)) issue(issues, 'run-metadata-timestamp-invalid');
  if (containsSensitiveField(value)) issue(issues, 'run-metadata-sensitive-field');
  return {
    status: statusFor(true, valid),
    ...(runId ? { runId } : {}),
    ...(validTimestamp(capturedAt) ? { capturedAt } : {}),
    ...(producer ? { producer } : {}),
    ...(sourceRef ? { sourceRef } : {}),
    metadataDigest: safeDigest(value)
  };
}

function localOrFixtureSource(value) {
  const source = String(pickFirst(value?.source, value?.sourceRef, '')).toLowerCase().replaceAll('\\', '/');
  const scope = String(pickFirst(value?.scope, value?.evidenceType, '')).toLowerCase();
  return (
    scope === 'local' ||
    scope === 'fixture' ||
    scope === 'test' ||
    source.includes('fixture') ||
    source.startsWith('tests/') ||
    source.startsWith('packages/') ||
    source.includes('/tests/') ||
    source.includes('/packages/')
  );
}

function normalizeFreezeGroup(value, id, issues) {
  if (!isRecord(value)) {
    issue(issues, `phase23-${id}-missing`);
    return { id, status: 'missing' };
  }
  const rawStatus = value.status;
  const source = safeDescriptor(pickFirst(value.source, value.sourceRef, value.evidenceRef));
  const recordedAt = pickFirst(value.recordedAt, value.observedAt, value.capturedAt);
  const validRecord =
    rawStatus === 'passed' &&
    Boolean(source) &&
    validTimestamp(recordedAt) &&
    !localOrFixtureSource(value) &&
    !containsSensitiveField(value);
  if (!VALID_GROUP_STATUSES.has(rawStatus) || rawStatus !== 'passed') issue(issues, `phase23-${id}-not-passed`);
  if (!source || !validTimestamp(recordedAt)) issue(issues, `phase23-${id}-provenance-missing`);
  if (localOrFixtureSource(value)) issue(issues, `phase23-${id}-local-or-fixture`);
  if (containsSensitiveField(value)) issue(issues, `phase23-${id}-sensitive-field`);
  return {
    id,
    status: validRecord ? 'passed' : rawStatus === 'failed' ? 'failed' : 'pending',
    ...(source ? { source } : {}),
    ...(validTimestamp(recordedAt) ? { recordedAt } : {}),
    evidenceDigest: safeDigest(value)
  };
}

function normalizeFreezeEvidence(input, metadata, phase18, signals, issues) {
  const evidenceInput = pickFirst(
    input,
    metadata?.evidence,
    metadata?.phase23Evidence,
    metadata?.finalFreezeEvidence
  );
  const rawEvidence = isRecord(evidenceInput) ? evidenceInput : {};
  const evidence = {};
  for (const { id, label } of FINAL_FREEZE_GROUPS) {
    let entry = normalizeFreezeGroup(rawEvidence[id], id, issues);
    if (id === 'evals' && phase18.status !== 'passed') {
      if (entry.status === 'passed') {
        issue(issues, 'phase23-evals-requires-complete-phase18');
        entry = { ...entry, status: 'pending' };
      }
    }
    if (id === 'vertical-slices' && (signals.gui.status !== 'passed' || signals['dual-instance'].status !== 'passed')) {
      if (entry.status === 'passed') {
        issue(issues, 'phase23-vertical-slices-requires-gui-and-dual-instance');
        entry = { ...entry, status: 'pending' };
      }
    }
    if (id === 'observability' && signals.observability.status !== 'passed') {
      if (entry.status === 'passed') {
        issue(issues, 'phase23-observability-observation-required');
        entry = { ...entry, status: 'pending' };
      }
    }
    evidence[id] = { id, label, ...entry };
  }
  return evidence;
}

function phase23Summary(evidence, signals) {
  const groups = Object.values(evidence);
  const missing = groups.filter((group) => group.status === 'missing').map((group) => group.id);
  const pending = groups.filter((group) => group.status === 'pending').map((group) => group.id);
  const failed = groups.filter((group) => group.status === 'failed').map((group) => group.id);
  const missingSignals = Object.entries(signals)
    .filter(([, value]) => value.status !== 'passed')
    .map(([key]) => `${key}-observation`);
  const eligible = groups.length === FINAL_FREEZE_GROUPS.length && groups.every((group) => group.status === 'passed');
  return {
    status: eligible ? 'passed' : failed.length > 0 ? 'failed' : 'pending',
    passed: eligible,
    eligible,
    requiredGroupCount: FINAL_FREEZE_GROUPS.length,
    passedGroupCount: groups.filter((group) => group.status === 'passed').length,
    missing,
    pending,
    failed,
    missingSignals
  };
}

function safeIsoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (validTimestamp(value)) return new Date(value).toISOString();
  return new Date().toISOString();
}

function collectionParts(options) {
  const outer = isRecord(options) ? options : {};
  const combined = outer.combinedInput;
  const combinedRecord = isRecord(combined) ? combined : {};
  const directChapterInput = pickFirst(
    outer.chapterInput,
    outer.chapterCorpus,
    outer.chaptersInput,
    combinedRecord.chapterInput,
    combinedRecord.chapterCorpus,
    combinedRecord.chaptersInput
  );
  const chapterInput =
    directChapterInput ??
    (hasChapterInputShape(combinedRecord) ? combinedRecord : undefined) ??
    (hasChapterInputShape(outer) ? outer : undefined);
  return {
    chapterInput,
    humanLabels: pickFirst(outer.humanLabels, outer.labels, combinedRecord.humanLabels, combinedRecord.labels),
    providerResults: pickFirst(
      outer.providerResults,
      outer.provider,
      combinedRecord.providerResults,
      combinedRecord.provider
    ),
    runtimeObservations: pickFirst(
      outer.runtimeObservations,
      outer.runtime,
      combinedRecord.runtimeObservations,
      combinedRecord.runtime
    ),
    runMetadata: pickFirst(outer.runMetadata, outer.metadata, combinedRecord.runMetadata, combinedRecord.metadata),
    phase23Evidence: pickFirst(
      outer.phase23Evidence,
      outer.evidence,
      combinedRecord.phase23Evidence,
      combinedRecord.evidence
    ),
    guiObservation: pickFirst(outer.guiObservation, outer.gui, combinedRecord.guiObservation, combinedRecord.gui),
    dualInstanceObservation: pickFirst(
      outer.dualInstanceObservation,
      outer.dualInstance,
      combinedRecord.dualInstanceObservation,
      combinedRecord.dualInstance
    ),
    observabilityObservation: pickFirst(
      outer.observabilityObservation,
      outer.observability,
      combinedRecord.observabilityObservation,
      combinedRecord.observability
    ),
    timestamp: pickFirst(outer.timestamp, combinedRecord.timestamp)
  };
}

/**
 * Build a redacted, auditable Phase 18/23 record from externally produced
 * inputs. This function never invokes a provider and never copies payloads.
 */
export function collectPhase18Evidence(options = {}) {
  const parts = collectionParts(options);
  const issues = [];
  const chapterInput = normalizeChapterInput(parts.chapterInput, issues);
  const labels = normalizeHumanLabels(parts.humanLabels, issues);
  const provider = normalizeProviderResults(parts.providerResults, chapterInput, issues);
  const runtime = normalizeRuntimeObservations(parts.runtimeObservations, chapterInput, issues);
  const run = normalizeRunMetadata(parts.runMetadata, issues);
  const fallbackTimestamp = run.capturedAt;
  const signals = {
    gui: normalizeSignal(
      'gui',
      pickFirst(parts.guiObservation, parts.runMetadata?.guiObservation, parts.runMetadata?.gui),
      fallbackTimestamp,
      issues
    ),
    'dual-instance': normalizeSignal(
      'dual-instance',
      pickFirst(parts.dualInstanceObservation, parts.runMetadata?.dualInstanceObservation, parts.runMetadata?.dualInstance),
      fallbackTimestamp,
      issues
    ),
    observability: normalizeSignal(
      'observability',
      pickFirst(parts.observabilityObservation, parts.runMetadata?.observabilityObservation, parts.runMetadata?.observability),
      fallbackTimestamp,
      issues
    )
  };
  const phase18Valid =
    chapterInput.status === 'passed' &&
    labels.status === 'passed' &&
    provider.status === 'passed' &&
    runtime.status === 'passed' &&
    run.status === 'passed';
  const phase18 = {
    status: phase18Valid ? 'passed' : [chapterInput, labels, provider, runtime, run].every((entry) => entry.status === 'missing') ? 'missing' : 'pending',
    passed: phase18Valid,
    eligible: phase18Valid,
    chapterInputs: chapterInput.summaries,
    humanLabels: labels,
    provider: {
      status: provider.status,
      benchmarks: provider.summaries,
      ...(provider.digest ? { digest: provider.digest } : {})
    },
    runtimeObservations: {
      status: runtime.status,
      benchmarks: runtime.summaries,
      ...(runtime.digest ? { digest: runtime.digest } : {})
    },
    runMetadata: run
  };
  const evidence = normalizeFreezeEvidence(parts.phase23Evidence, parts.runMetadata, phase18, signals, issues);
  const phase23 = phase23Summary(evidence, signals);
  const eligible = phase18.passed && phase23.eligible;
  const failed = phase23.failed.length > 0;
  const status = eligible ? 'passed' : failed ? 'failed' : 'pending';
  const generatedAt = safeIsoTimestamp(parts.timestamp ?? run.capturedAt);
  return {
    schemaVersion: PHASE18_23_SCHEMA_VERSION,
    kind: PHASE18_23_KIND,
    generatedAt,
    status,
    passed: eligible,
    eligible,
    phase18,
    evidence,
    phase23,
    run,
    security: {
      credentialValuesWritten: false,
      chapterBodiesWritten: false,
      providerBodiesWritten: false,
      privateReasoningWritten: false
    },
    violations: issues
  };
}

export function createPhase18EvidenceTemplate(timestamp = Date.now()) {
  return collectPhase18Evidence({ timestamp });
}

function readJsonFile(filePath) {
  if (!nonEmptyString(filePath)) throw new Error('Input path is missing.');
  const normalized = resolve(filePath);
  if (!existsSync(normalized)) throw new Error('Input file does not exist.');
  try {
    return JSON.parse(readFileSync(normalized, 'utf8'));
  } catch {
    throw new Error('Input file is not valid JSON.');
  }
}

function parseArgs(argv) {
  const options = { template: false, input: undefined, chapters: undefined, labels: undefined, provider: undefined, runtime: undefined, metadata: undefined, evidence: undefined, output: undefined, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--template') {
      options.template = true;
      continue;
    }
    const next = argv[index + 1];
    const mapping = {
      '--input': 'input',
      '--chapters': 'chapters',
      '--chapter-input': 'chapters',
      '--labels': 'labels',
      '--human-labels': 'labels',
      '--provider': 'provider',
      '--provider-results': 'provider',
      '--runtime': 'runtime',
      '--runtime-observations': 'runtime',
      '--metadata': 'metadata',
      '--run-metadata': 'metadata',
      '--evidence': 'evidence',
      '--phase23-evidence': 'evidence',
      '--output': 'output'
    };
    const key = mapping[argument];
    if (key) {
      if (!nonEmptyString(next)) throw new Error(`${argument} requires a path.`);
      options[key] = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/phase18-23-evidence.mjs --chapters <phase18-input.json> [options]',
      '',
      'Options:',
      '  --labels <file>       Human-labelled gold/pairwise records.',
      '  --provider <file>     Already captured real-provider result records.',
      '  --runtime <file>      Runtime retained/cache/recovery observations.',
      '  --metadata <file>     Run id, capture time, and GUI/instance/privacy observations.',
      '  --evidence <file>     External Phase 23 group records.',
      '  --output <file>       Write a new redacted record; stdout is the default.',
      '  --template             Emit a pending template without input files.',
      '',
      'The harness is read-only with respect to evidence sources. It never calls a provider, reads API-key',
      'environment variables, or writes chapter/provider payloads. Missing external evidence remains pending.'
    ].join('\n') + '\n'
  );
}

function formalEvidencePath(filePath) {
  const normalized = resolve(filePath).replaceAll('\\', '/').toLowerCase();
  return normalized.includes('/docs/evidence/');
}

export function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      printHelp();
      return 0;
    }
    if (options.template && (options.input || options.chapters || options.labels || options.provider || options.runtime || options.metadata || options.evidence)) {
      throw new Error('--template cannot be combined with input files.');
    }
    let record;
    if (options.template) {
      record = createPhase18EvidenceTemplate();
    } else {
      const documents = {
        input: options.input ? readJsonFile(options.input) : undefined,
        chapters: options.chapters ? readJsonFile(options.chapters) : undefined,
        labels: options.labels ? readJsonFile(options.labels) : undefined,
        provider: options.provider ? readJsonFile(options.provider) : undefined,
        runtime: options.runtime ? readJsonFile(options.runtime) : undefined,
        metadata: options.metadata ? readJsonFile(options.metadata) : undefined,
        evidence: options.evidence ? readJsonFile(options.evidence) : undefined
      };
      const combined = documents.input;
      record = collectPhase18Evidence({
        combinedInput: combined,
        chapterInput: documents.chapters,
        humanLabels: documents.labels,
        providerResults: documents.provider,
        runtimeObservations: documents.runtime,
        runMetadata: documents.metadata,
        phase23Evidence: documents.evidence
      });
    }
    const serialized = `${JSON.stringify(record, null, 2)}\n`;
    if (options.output) {
      if (formalEvidencePath(options.output)) throw new Error('Refusing to overwrite formal evidence JSON.');
      writeFileSync(resolve(options.output), serialized, { encoding: 'utf8', flag: 'wx' });
    } else {
      process.stdout.write(serialized);
    }
    process.stderr.write(`phase18-23-evidence: status=${record.status}; phase18=${record.phase18.status}; phase23=${record.phase23.status}\n`);
    return record.passed ? 0 : options.template ? 0 : 2;
  } catch (error) {
    process.stderr.write(`phase18-23-evidence: ${error instanceof Error ? error.message : 'invalid input'}\n`);
    return 2;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (entryPath === fileURLToPath(import.meta.url)) process.exitCode = main();
