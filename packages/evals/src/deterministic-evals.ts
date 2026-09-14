import type { RuntimeState } from '@inkpi/protocol';
import type { LongContextBenchmark, LongContextChapter } from './fixtures.js';

export interface DeterministicViolation {
  code: string;
  message: string;
  path?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface DeterministicEvaluationReport {
  score: number;
  passed: boolean;
  violations: DeterministicViolation[];
  metrics: Record<string, number>;
}

function createReport(
  violations: DeterministicViolation[],
  metrics: Record<string, number>
): DeterministicEvaluationReport {
  const score = Math.max(0, 100 - violations.length * 25);
  return {
    score,
    passed: violations.length === 0,
    violations,
    metrics
  };
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
}

function valueKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export interface EntityFact {
  entity: string;
  status?: string;
  attributes?: Record<string, unknown>;
  chapter?: number;
}

export interface EntityAssertion extends EntityFact {
  action?: string;
  text?: string;
}

export interface EntityLedgerEntry {
  entity?: string;
  name?: string;
  status?: string;
  attributes?: Record<string, unknown>;
}

export interface EntityContradictionInput {
  /** Current opaque RuntimeState input. */
  runtimeState?: RuntimeState;
  /** @deprecated Use runtimeState. This name remains only for API compatibility. */
  ledger?: RuntimeState;
  facts?: readonly EntityFact[];
  claims?: readonly EntityAssertion[];
  observations?: readonly EntityAssertion[];
  event?: EntityAssertion;
  text?: string;
}

export interface EntityContradictionReport extends DeterministicEvaluationReport {
  metrics: DeterministicEvaluationReport['metrics'] & {
    entityCount: number;
    claimCount: number;
    contradictionCount: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isEntityLedgerEntry(value: unknown): value is EntityLedgerEntry {
  if (!isRecord(value)) return false;
  return (
    (value.entity === undefined || typeof value.entity === 'string') &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.status === undefined || typeof value.status === 'string') &&
    (value.attributes === undefined || isRecord(value.attributes))
  );
}

function readRuntimeEntities(state: RuntimeState | undefined): EntityLedgerEntry[] {
  const entities = state ? (state as Record<string, unknown>).entities : undefined;
  return Array.isArray(entities) ? entities.filter(isEntityLedgerEntry) : [];
}

const terminalEntityStatuses = new Set(['dead', 'deceased', '死亡', '已故']);
const injuredEntityStatuses = new Set(['injured', 'wounded', '重伤', '受伤']);

function hasStatus(status: string | undefined, values: ReadonlySet<string>): boolean {
  const value = normalized(status);
  return value !== '' && (values.has(value) || [...values].some((candidate) => value.includes(candidate)));
}

function actionContradictsStatus(status: string | undefined, action: string | undefined): boolean {
  const actionText = normalized(action);
  if (!actionText) return false;
  if (hasStatus(status, terminalEntityStatuses)) {
    return /return|returns|returned|alive|resurrect|revive|appear|回归|返回|复活|出现|活着/.test(actionText);
  }
  if (hasStatus(status, injuredEntityStatuses)) {
    return /sprint|run|running|jump|跃起|奔跑|疾跑|全力/.test(actionText);
  }
  return false;
}

function textContradictsStatus(status: string | undefined, text: string): boolean {
  if (hasStatus(status, terminalEntityStatuses)) {
    return /return|returns|returned|alive|resurrect|revive|appear|回归|返回|复活|出现|活着/.test(text);
  }
  if (hasStatus(status, injuredEntityStatuses)) {
    return /without errors|完好无损|生龙活虎|奔跑|纵身跃起|全力狂奔/.test(text);
  }
  return false;
}

function addEntityContradiction(
  violations: DeterministicViolation[],
  code: string,
  message: string,
  path: string,
  expected: unknown,
  actual: unknown
): void {
  violations.push({ code, message, path, expected, actual });
}

export function evaluateEntityContradiction(input: EntityContradictionInput): EntityContradictionReport {
  const violations: DeterministicViolation[] = [];
  const ledgerEntities = readRuntimeEntities(input.runtimeState ?? input.ledger);
  const facts = [
    ...ledgerEntities.map((entity) => ({
      entity: entity.entity ?? entity.name ?? '',
      status: entity.status,
      attributes: entity.attributes
    })),
    ...(input.facts ?? [])
  ];
  const claims = [...(input.claims ?? []), ...(input.observations ?? []), ...(input.event ? [input.event] : [])];
  const factsByEntity = new Map<string, EntityFact[]>();

  for (const [index, fact] of facts.entries()) {
    const entity = typeof fact.entity === 'string' ? fact.entity.trim() : '';
    if (!entity) {
      violations.push({
        code: 'entity-name-missing',
        message: 'Entity facts must include a non-empty entity name.',
        path: `facts[${index}].entity`
      });
      continue;
    }
    const entries = factsByEntity.get(entity) ?? [];
    entries.push({ ...fact, entity });
    factsByEntity.set(entity, entries);
  }

  for (const [entity, entityFacts] of factsByEntity) {
    const statuses = new Set(entityFacts.map((fact) => normalized(fact.status)).filter((status) => status.length > 0));
    if (statuses.size > 1) {
      addEntityContradiction(
        violations,
        'entity-fact-contradiction',
        `Entity ${entity} has mutually exclusive baseline statuses.`,
        `facts.${entity}.status`,
        'one status',
        [...statuses]
      );
    }
  }

  for (const [index, claim] of claims.entries()) {
    const entity = typeof claim.entity === 'string' ? claim.entity.trim() : '';
    if (!entity) {
      violations.push({
        code: 'claim-entity-missing',
        message: 'Entity claims must include a non-empty entity name.',
        path: `claims[${index}].entity`
      });
      continue;
    }
    const baseline = factsByEntity.get(entity)?.[0];
    if (!baseline) continue;

    if (claim.status !== undefined && baseline.status !== undefined) {
      const expectedStatus = normalized(baseline.status);
      const actualStatus = normalized(claim.status);
      if (expectedStatus !== actualStatus) {
        addEntityContradiction(
          violations,
          'entity-status-contradiction',
          `Entity ${entity} claim status conflicts with the baseline status.`,
          `claims[${index}].status`,
          baseline.status,
          claim.status
        );
      }
    }

    if (claim.attributes && baseline.attributes) {
      for (const [key, actual] of Object.entries(claim.attributes)) {
        if (!(key in baseline.attributes)) continue;
        const expected = baseline.attributes[key];
        if (valueKey(expected) !== valueKey(actual)) {
          addEntityContradiction(
            violations,
            'entity-attribute-contradiction',
            `Entity ${entity} claim attribute conflicts with the baseline attribute.`,
            `claims[${index}].attributes.${key}`,
            expected,
            actual
          );
        }
      }
    }

    if (actionContradictsStatus(baseline.status, claim.action)) {
      addEntityContradiction(
        violations,
        'entity-action-contradiction',
        `Entity ${entity} action is incompatible with its baseline status.`,
        `claims[${index}].action`,
        'status-compatible action',
        claim.action
      );
    }

    if (claim.text && textContradictsStatus(baseline.status, claim.text)) {
      addEntityContradiction(
        violations,
        'entity-text-contradiction',
        `Entity ${entity} text implies a state incompatible with its baseline status.`,
        `claims[${index}].text`,
        'status-compatible text',
        claim.text
      );
    }
  }

  if (input.text) {
    for (const [entity, entityFacts] of factsByEntity) {
      const baseline = entityFacts[0];
      if (input.text.includes(entity) && textContradictsStatus(baseline.status, input.text)) {
        addEntityContradiction(
          violations,
          'entity-context-contradiction',
          `Entity ${entity} context conflicts with its baseline status.`,
          'text',
          'status-compatible text',
          input.text
        );
      }
    }
  }

  const report = createReport(violations, {
    entityCount: factsByEntity.size,
    claimCount: claims.length,
    contradictionCount: violations.length
  });
  return report as EntityContradictionReport;
}

export const evaluateEntityContradictions = evaluateEntityContradiction;

export class EntityContradictionEvaluator {
  public evaluate(input: EntityContradictionInput): EntityContradictionReport {
    return evaluateEntityContradiction(input);
  }
}

export interface StateTransitionRecord {
  entity: string;
  from: string;
  to: string;
  event?: string;
  chapter?: number;
}

export type EntityTransitionRules = Record<string, Record<string, readonly string[]>>;
export type TransitionRules = EntityTransitionRules | Record<string, readonly string[]>;
export type TerminalStateRules = readonly string[] | Record<string, readonly string[]>;

export interface InvalidStateTransitionInput {
  initial?: Record<string, string> | readonly EntityFact[];
  transitions: readonly StateTransitionRecord[];
  allowedTransitions?: TransitionRules;
  terminalStates?: TerminalStateRules;
}

export interface InvalidStateTransitionReport extends DeterministicEvaluationReport {
  finalStates: Record<string, string>;
  metrics: DeterministicEvaluationReport['metrics'] & {
    transitionCount: number;
    invalidTransitionCount: number;
  };
}

function initialStateMap(initial: InvalidStateTransitionInput['initial']): Map<string, string> {
  if (!initial) return new Map();
  if (Array.isArray(initial)) {
    return new Map(initial.filter((fact) => Boolean(fact.entity)).map((fact) => [fact.entity, fact.status ?? '']));
  }
  return new Map(Object.entries(initial));
}

function allowedTargets(
  rules: TransitionRules | undefined,
  entity: string,
  from: string
): readonly string[] | undefined {
  if (!rules) return undefined;
  const record = rules as Record<string, unknown>;
  const entityRule = record[entity];
  if (Array.isArray(entityRule)) return entityRule.filter((value): value is string => typeof value === 'string');
  if (entityRule && typeof entityRule === 'object') {
    const targets = (entityRule as Record<string, unknown>)[from];
    if (Array.isArray(targets)) return targets.filter((value): value is string => typeof value === 'string');
  }
  const globalRule = record[from];
  if (Array.isArray(globalRule)) return globalRule.filter((value): value is string => typeof value === 'string');
  return undefined;
}

function isTerminalState(terminalStates: TerminalStateRules | undefined, entity: string, state: string): boolean {
  if (!terminalStates) return false;
  if (Array.isArray(terminalStates)) return terminalStates.includes(state);
  return (terminalStates as Record<string, readonly string[]>)[entity]?.includes(state) ?? false;
}

export function evaluateInvalidStateTransition(input: InvalidStateTransitionInput): InvalidStateTransitionReport {
  const violations: DeterministicViolation[] = [];
  const states = initialStateMap(input.initial);

  for (const [index, transition] of input.transitions.entries()) {
    const entity = typeof transition.entity === 'string' ? transition.entity.trim() : '';
    const from = typeof transition.from === 'string' ? transition.from.trim() : '';
    const to = typeof transition.to === 'string' ? transition.to.trim() : '';
    const path = `transitions[${index}]`;

    if (!entity || !from || !to) {
      violations.push({
        code: 'transition-field-missing',
        message: 'State transitions require entity, from, and to values.',
        path
      });
      continue;
    }

    const current = states.get(entity);
    if (current === undefined) {
      states.set(entity, from);
    } else if (current !== from) {
      violations.push({
        code: 'transition-source-mismatch',
        message: `Transition source does not match the current state for ${entity}.`,
        path: `${path}.from`,
        expected: current,
        actual: from
      });
    }

    const effectiveFrom = states.get(entity) ?? from;
    if (isTerminalState(input.terminalStates, entity, effectiveFrom) && effectiveFrom !== to) {
      violations.push({
        code: 'transition-from-terminal-state',
        message: `Terminal state ${effectiveFrom} cannot transition to ${to}.`,
        path: `${path}.to`,
        expected: effectiveFrom,
        actual: to
      });
    }

    const targets = allowedTargets(input.allowedTransitions, entity, from);
    if (from !== to && targets && !targets.includes(to)) {
      violations.push({
        code: 'transition-not-allowed',
        message: `Transition ${entity}:${from} -> ${to} is not allowed.`,
        path: `${path}.to`,
        expected: targets,
        actual: to
      });
    }

    states.set(entity, to);
  }

  const finalStates = Object.fromEntries(states.entries());
  const report = createReport(violations, {
    transitionCount: input.transitions.length,
    invalidTransitionCount: violations.length
  });
  return { ...report, finalStates } as InvalidStateTransitionReport;
}

export const evaluateInvalidStateTransitions = evaluateInvalidStateTransition;

export class InvalidStateTransitionEvaluator {
  public evaluate(input: InvalidStateTransitionInput): InvalidStateTransitionReport {
    return evaluateInvalidStateTransition(input);
  }
}

export interface SourceRange {
  from: number;
  to: number;
}

export interface SourceMapSegmentLike {
  blockId?: string;
  semanticFrom: number;
  semanticTo: number;
  editorFrom: number;
  editorTo: number;
}

export interface SourceMapRangeAssertion {
  source?: SourceRange;
  target?: SourceRange;
  editor?: SourceRange;
  semantic?: SourceRange;
}

export interface SourceMapProbe {
  semantic?: number;
  editor?: number;
  expectedEditor?: number;
  expectedSemantic?: number;
}

export interface SourceMapRangeEvaluationInput {
  semanticText?: string;
  editorText?: string;
  semanticLength?: number;
  editorLength?: number;
  segments: readonly SourceMapSegmentLike[];
  ranges?: readonly SourceMapRangeAssertion[];
  probes?: readonly SourceMapProbe[];
  requireCoverage?: boolean;
}

export interface SourceMapRangeEvaluationReport extends DeterministicEvaluationReport {
  metrics: DeterministicEvaluationReport['metrics'] & {
    segmentCount: number;
    invalidSegmentCount: number;
    rangeCount: number;
    invalidRangeCount: number;
    coverageGapCount: number;
  };
}

function finiteLength(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value as number) >= 0 ? (value as number) : fallback;
}

function maxSegmentEndpoint(segments: readonly SourceMapSegmentLike[], key: 'semanticTo' | 'editorTo'): number {
  return segments.reduce((maximum, segment) => Math.max(maximum, segment[key]), 0);
}

function validateRange(
  range: SourceRange | undefined,
  length: number,
  path: string,
  violations: DeterministicViolation[]
): boolean {
  if (!range) return true;
  if (!Number.isInteger(range.from) || !Number.isInteger(range.to)) {
    violations.push({
      code: 'range-endpoint-not-integer',
      message: 'Range endpoints must be integers.',
      path,
      expected: 'integer endpoints',
      actual: range
    });
    return false;
  }
  if (range.from < 0 || range.to < range.from || range.to > length) {
    violations.push({
      code: 'range-out-of-bounds',
      message: 'Range is reversed or outside the source text bounds.',
      path,
      expected: { from: 0, to: length },
      actual: range
    });
    return false;
  }
  return true;
}

function mapPosition(
  position: number,
  segments: readonly SourceMapSegmentLike[],
  direction: 'semantic-to-editor' | 'editor-to-semantic'
): number | undefined {
  const startKey = direction === 'semantic-to-editor' ? 'semanticFrom' : 'editorFrom';
  const endKey = direction === 'semantic-to-editor' ? 'semanticTo' : 'editorTo';
  const mappedStartKey = direction === 'semantic-to-editor' ? 'editorFrom' : 'semanticFrom';
  const mappedEndKey = direction === 'semantic-to-editor' ? 'editorTo' : 'semanticTo';
  const segment = segments.find((candidate) => position >= candidate[startKey] && position <= candidate[endKey]);
  if (!segment) return undefined;
  const span = segment[endKey] - segment[startKey];
  const mappedSpan = segment[mappedEndKey] - segment[mappedStartKey];
  if (span === 0) return segment[mappedStartKey];
  return segment[mappedStartKey] + Math.round(((position - segment[startKey]) / span) * mappedSpan);
}

export function evaluateSourceMapRanges(input: SourceMapRangeEvaluationInput): SourceMapRangeEvaluationReport {
  const violations: DeterministicViolation[] = [];
  const semanticLength = finiteLength(
    input.semanticLength,
    input.semanticText?.length ?? maxSegmentEndpoint(input.segments, 'semanticTo')
  );
  const editorLength = finiteLength(
    input.editorLength,
    input.editorText?.length ?? maxSegmentEndpoint(input.segments, 'editorTo')
  );
  let invalidSegmentCount = 0;
  let coverageGapCount = 0;

  for (const [index, segment] of input.segments.entries()) {
    const path = `segments[${index}]`;
    const validBlockId = typeof segment.blockId === 'string' && segment.blockId.trim().length > 0;
    const validSemantic = validateRange(
      { from: segment.semanticFrom, to: segment.semanticTo },
      semanticLength,
      `${path}.semantic`,
      violations
    );
    const validEditor = validateRange(
      { from: segment.editorFrom, to: segment.editorTo },
      editorLength,
      `${path}.editor`,
      violations
    );
    if (!validBlockId) {
      violations.push({
        code: 'source-map-block-missing',
        message: 'Source-map segments require a non-empty blockId.',
        path: `${path}.blockId`
      });
    }
    if (!validSemantic || !validEditor || !validBlockId) invalidSegmentCount++;

    const previous = input.segments[index - 1];
    if (previous && segment.semanticFrom < previous.semanticTo) {
      violations.push({
        code: 'source-map-semantic-order',
        message: 'Semantic source-map segments overlap or are out of order.',
        path: `${path}.semanticFrom`,
        expected: `>= ${previous.semanticTo}`,
        actual: segment.semanticFrom
      });
    }
    if (previous && segment.editorFrom < previous.editorTo) {
      violations.push({
        code: 'source-map-editor-order',
        message: 'Editor source-map segments overlap or are out of order.',
        path: `${path}.editorFrom`,
        expected: `>= ${previous.editorTo}`,
        actual: segment.editorFrom
      });
    }
    if (previous && segment.semanticFrom > previous.semanticTo) {
      coverageGapCount++;
      if (input.requireCoverage) {
        violations.push({
          code: 'source-map-semantic-gap',
          message: 'Required semantic source-map coverage contains an internal gap.',
          path: `${path}.semanticFrom`,
          expected: previous.semanticTo,
          actual: segment.semanticFrom
        });
      }
    }
    if (previous && segment.editorFrom > previous.editorTo) {
      coverageGapCount++;
      if (input.requireCoverage) {
        violations.push({
          code: 'source-map-editor-gap',
          message: 'Required editor source-map coverage contains an internal gap.',
          path: `${path}.editorFrom`,
          expected: previous.editorTo,
          actual: segment.editorFrom
        });
      }
    }
  }

  if (input.requireCoverage && input.segments.length === 0 && (semanticLength > 0 || editorLength > 0)) {
    coverageGapCount += 1;
    violations.push({
      code: 'source-map-coverage-missing',
      message: 'Source-map coverage is required for non-empty text.',
      path: 'segments',
      expected: 'at least one covering segment',
      actual: []
    });
  }

  if (input.requireCoverage && input.segments.length > 0) {
    const first = input.segments[0];
    const last = input.segments[input.segments.length - 1];
    if (first.semanticFrom !== 0 || last.semanticTo !== semanticLength) {
      coverageGapCount++;
      violations.push({
        code: 'source-map-semantic-coverage',
        message: 'Semantic source-map segments do not cover the complete semantic text.',
        path: 'segments',
        expected: { from: 0, to: semanticLength },
        actual: { from: first.semanticFrom, to: last.semanticTo }
      });
    }
    if (first.editorFrom !== 0 || last.editorTo !== editorLength) {
      coverageGapCount++;
      violations.push({
        code: 'source-map-editor-coverage',
        message: 'Editor source-map segments do not cover the complete editor text.',
        path: 'segments',
        expected: { from: 0, to: editorLength },
        actual: { from: first.editorFrom, to: last.editorTo }
      });
    }
  }

  let invalidRangeCount = 0;
  for (const [index, assertion] of (input.ranges ?? []).entries()) {
    const source = assertion.editor ?? assertion.source;
    const target = assertion.semantic ?? assertion.target;
    const sourceValid = validateRange(source, editorLength, `ranges[${index}].source`, violations);
    const targetValid = validateRange(target, semanticLength, `ranges[${index}].target`, violations);
    if (!sourceValid || !targetValid) invalidRangeCount++;
  }

  for (const [index, probe] of (input.probes ?? []).entries()) {
    if (
      probe.semantic !== undefined &&
      (!Number.isInteger(probe.semantic) || probe.semantic < 0 || probe.semantic > semanticLength)
    ) {
      violations.push({
        code: 'source-map-probe-out-of-bounds',
        message: 'Semantic source-map probe is outside the semantic text bounds.',
        path: `probes[${index}].semantic`,
        expected: { from: 0, to: semanticLength },
        actual: probe.semantic
      });
    }
    if (
      probe.editor !== undefined &&
      (!Number.isInteger(probe.editor) || probe.editor < 0 || probe.editor > editorLength)
    ) {
      violations.push({
        code: 'source-map-probe-out-of-bounds',
        message: 'Editor source-map probe is outside the editor text bounds.',
        path: `probes[${index}].editor`,
        expected: { from: 0, to: editorLength },
        actual: probe.editor
      });
    }
    if (probe.semantic !== undefined && probe.expectedEditor !== undefined) {
      const actual = mapPosition(probe.semantic, input.segments, 'semantic-to-editor');
      if (actual !== probe.expectedEditor) {
        violations.push({
          code: 'source-map-probe-mismatch',
          message: 'Semantic-to-editor source-map probe returned an unexpected position.',
          path: `probes[${index}].expectedEditor`,
          expected: probe.expectedEditor,
          actual
        });
      }
    }
    if (probe.editor !== undefined && probe.expectedSemantic !== undefined) {
      const actual = mapPosition(probe.editor, input.segments, 'editor-to-semantic');
      if (actual !== probe.expectedSemantic) {
        violations.push({
          code: 'source-map-probe-mismatch',
          message: 'Editor-to-semantic source-map probe returned an unexpected position.',
          path: `probes[${index}].expectedSemantic`,
          expected: probe.expectedSemantic,
          actual
        });
      }
    }
  }

  const report = createReport(violations, {
    segmentCount: input.segments.length,
    invalidSegmentCount,
    rangeCount: input.ranges?.length ?? 0,
    invalidRangeCount,
    coverageGapCount
  });
  return report as SourceMapRangeEvaluationReport;
}

export const evaluateSourceMapRange = evaluateSourceMapRanges;
export const evaluateSourceMap = evaluateSourceMapRanges;

export class SourceMapRangeEvaluator {
  public evaluate(input: SourceMapRangeEvaluationInput): SourceMapRangeEvaluationReport {
    return evaluateSourceMapRanges(input);
  }
}

export interface LongContextEvaluationInput {
  chapterCount: number;
  maxTokens: number;
  chapters?: readonly LongContextChapter[] | readonly string[];
  anchorChapters?: readonly number[];
  retainedChapters?: readonly number[];
  expectedAnchorRecall?: number;
  entityCount?: number;
  foreshadowingCount?: number;
  cacheLookups?: number;
  cacheHits?: number;
  checkpoint?: {
    totalChapters: number;
    completedChapters: number;
    nextChapter: number;
  };
}

export interface LongContextPruningResult {
  selectedChapters: number[];
  omittedChapters: number[];
  estimatedTokens: number;
  anchorRecall: number;
}

export interface LongContextEvaluationReport extends DeterministicEvaluationReport {
  selectedChapters: number[];
  retainedChapterCount: number;
  anchorRecall: number;
  cacheHitRate: number | undefined;
  checkpointValid: boolean | undefined;
  metrics: DeterministicEvaluationReport['metrics'] & {
    chapterCount: number;
    maxTokens: number;
    estimatedTokens: number;
    prunedChapterCount: number;
    anchorRecallPercent: number;
    cacheHitRatePercent: number;
  };
}

function normalizeChapters(
  chapters: readonly LongContextChapter[] | readonly string[] | undefined,
  chapterCount: number
): LongContextChapter[] {
  if (!chapters) {
    return Array.from({ length: chapterCount }, (_, index) => ({ chapter: index + 1, text: `chapter-${index + 1}` }));
  }
  return chapters.map((chapter, index) =>
    typeof chapter === 'string' ? { chapter: index + 1, text: chapter } : chapter
  );
}

export function estimateContextTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function pruneLongContextChapters(
  chapters: readonly LongContextChapter[] | readonly string[],
  maxTokens: number,
  anchorChapters: readonly number[] = []
): LongContextPruningResult {
  const normalizedChapters = normalizeChapters(chapters, chapters.length);
  const byNumber = new Map(normalizedChapters.map((chapter) => [chapter.chapter, chapter]));
  const selected = new Set<number>();
  let estimatedTokens = 0;

  const trySelect = (chapter: LongContextChapter | undefined): void => {
    if (!chapter || selected.has(chapter.chapter)) return;
    const cost = estimateContextTokens(chapter.text);
    if (estimatedTokens + cost > maxTokens) return;
    selected.add(chapter.chapter);
    estimatedTokens += cost;
  };

  for (const chapterNumber of anchorChapters) trySelect(byNumber.get(chapterNumber));
  for (const chapter of [...normalizedChapters].sort((left, right) => right.chapter - left.chapter)) trySelect(chapter);

  const selectedChapters = [...selected].sort((left, right) => left - right);
  const omittedChapters = normalizedChapters
    .map((chapter) => chapter.chapter)
    .filter((chapter) => !selected.has(chapter));
  const anchors = anchorChapters.filter((chapter) => byNumber.has(chapter));
  const retainedAnchors = anchors.filter((chapter) => selected.has(chapter));
  return {
    selectedChapters,
    omittedChapters,
    estimatedTokens,
    anchorRecall: anchors.length === 0 ? 1 : retainedAnchors.length / anchors.length
  };
}

function asLongContextInput(input: LongContextEvaluationInput | LongContextBenchmark): LongContextEvaluationInput {
  if ('task' in input) {
    return {
      chapterCount: input.chapterCount,
      maxTokens: input.task.contextPolicy?.maxTokens ?? input.expectedMaxTokens,
      chapters: input.chapters,
      anchorChapters: input.anchorChapterNumbers
    };
  }
  return input;
}

export function evaluateLongContextBenchmark(
  input: LongContextEvaluationInput | LongContextBenchmark
): LongContextEvaluationReport {
  const normalizedInput = asLongContextInput(input);
  const violations: DeterministicViolation[] = [];
  const chapters = normalizeChapters(normalizedInput.chapters, normalizedInput.chapterCount);
  const anchorChapters = [...(normalizedInput.anchorChapters ?? [])];
  const pruning = pruneLongContextChapters(chapters, normalizedInput.maxTokens, anchorChapters);
  const selectedChapters = normalizedInput.retainedChapters
    ? [...normalizedInput.retainedChapters].sort((left, right) => left - right)
    : pruning.selectedChapters;
  const chapterNumbers = new Set(chapters.map((chapter) => chapter.chapter));
  const selectedSet = new Set(selectedChapters);
  const retainedTokens = chapters
    .filter((chapter) => selectedSet.has(chapter.chapter))
    .reduce((sum, chapter) => sum + estimateContextTokens(chapter.text), 0);
  const anchors = anchorChapters.filter((chapter) => chapterNumbers.has(chapter));
  const retainedAnchors = anchors.filter((chapter) => selectedSet.has(chapter));
  const anchorRecall = anchors.length === 0 ? 1 : retainedAnchors.length / anchors.length;

  if (!Number.isInteger(normalizedInput.chapterCount) || normalizedInput.chapterCount < 1) {
    violations.push({
      code: 'chapter-count-invalid',
      message: 'Long-context benchmarks require a positive integer chapter count.',
      path: 'chapterCount',
      expected: 'positive integer',
      actual: normalizedInput.chapterCount
    });
  }
  if (normalizedInput.chapters && chapters.length !== normalizedInput.chapterCount) {
    violations.push({
      code: 'chapter-count-mismatch',
      message: 'Provided chapter data does not match the declared chapter count.',
      path: 'chapters',
      expected: normalizedInput.chapterCount,
      actual: chapters.length
    });
  }
  if (!Number.isInteger(normalizedInput.maxTokens) || normalizedInput.maxTokens < 1) {
    violations.push({
      code: 'context-budget-invalid',
      message: 'Long-context benchmarks require a positive integer token budget.',
      path: 'maxTokens',
      expected: 'positive integer',
      actual: normalizedInput.maxTokens
    });
  }
  for (const chapter of selectedChapters) {
    if (!chapterNumbers.has(chapter)) {
      violations.push({
        code: 'retained-chapter-missing',
        message: 'Retained chapter list contains a chapter that is not in the benchmark.',
        path: 'retainedChapters',
        actual: chapter
      });
    }
  }
  if (retainedTokens > normalizedInput.maxTokens) {
    violations.push({
      code: 'context-budget-overflow',
      message: 'Retained long-context chapters exceed the token budget.',
      path: 'retainedChapters',
      expected: normalizedInput.maxTokens,
      actual: retainedTokens
    });
  }
  const expectedAnchorRecall = normalizedInput.expectedAnchorRecall ?? (anchors.length > 0 ? 1 : 0);
  if (anchorRecall < expectedAnchorRecall) {
    violations.push({
      code: 'retrieval-recall-low',
      message: 'Context pruning dropped more anchor chapters than the benchmark allows.',
      path: 'anchorChapters',
      expected: expectedAnchorRecall,
      actual: anchorRecall
    });
  }
  if (normalizedInput.entityCount !== undefined && normalizedInput.entityCount < 1) {
    violations.push({
      code: 'entity-fixture-empty',
      message: 'Long-context fixture must contain at least one tracked entity.',
      path: 'entityCount',
      expected: '>= 1',
      actual: normalizedInput.entityCount
    });
  }
  if (normalizedInput.foreshadowingCount !== undefined && normalizedInput.foreshadowingCount < 1) {
    violations.push({
      code: 'foreshadowing-fixture-empty',
      message: 'Long-context fixture must contain at least one tracked foreshadowing item.',
      path: 'foreshadowingCount',
      expected: '>= 1',
      actual: normalizedInput.foreshadowingCount
    });
  }

  let cacheHitRate: number | undefined;
  if (normalizedInput.cacheLookups !== undefined || normalizedInput.cacheHits !== undefined) {
    const lookups = normalizedInput.cacheLookups ?? 0;
    const hits = normalizedInput.cacheHits ?? 0;
    if (!Number.isInteger(lookups) || lookups < 1 || !Number.isInteger(hits) || hits < 0 || hits > lookups) {
      violations.push({
        code: 'cache-statistics-invalid',
        message: 'Cache lookups and hits must be integers with 0 <= hits <= lookups.',
        path: 'cache',
        actual: { lookups, hits }
      });
    } else {
      cacheHitRate = hits / lookups;
    }
  }

  let checkpointValid: boolean | undefined;
  if (normalizedInput.checkpoint) {
    const checkpoint = normalizedInput.checkpoint;
    checkpointValid =
      checkpoint.totalChapters === normalizedInput.chapterCount &&
      Number.isInteger(checkpoint.completedChapters) &&
      checkpoint.completedChapters >= 0 &&
      checkpoint.completedChapters <= checkpoint.totalChapters &&
      checkpoint.nextChapter === checkpoint.completedChapters + 1;
    if (!checkpointValid) {
      violations.push({
        code: 'distillation-checkpoint-invalid',
        message: 'Distillation checkpoint must resume at completedChapters + 1.',
        path: 'checkpoint',
        expected: {
          totalChapters: normalizedInput.chapterCount,
          nextChapter: checkpoint.completedChapters + 1
        },
        actual: checkpoint
      });
    }
  }

  const report = createReport(violations, {
    chapterCount: normalizedInput.chapterCount,
    maxTokens: normalizedInput.maxTokens,
    estimatedTokens: retainedTokens,
    prunedChapterCount: normalizedInput.chapterCount - selectedChapters.length,
    anchorRecallPercent: Math.round(anchorRecall * 100),
    cacheHitRatePercent: cacheHitRate === undefined ? 0 : Math.round(cacheHitRate * 100)
  });
  return {
    ...report,
    selectedChapters,
    retainedChapterCount: selectedChapters.length,
    anchorRecall,
    cacheHitRate,
    checkpointValid
  } as LongContextEvaluationReport;
}

export const evaluateLongContext = evaluateLongContextBenchmark;

export class LongContextEvaluator {
  public evaluate(input: LongContextEvaluationInput | LongContextBenchmark): LongContextEvaluationReport {
    return evaluateLongContextBenchmark(input);
  }
}

export interface MutationEvaluationInput<T> {
  name: string;
  baseline: T;
  mutated: T;
  repaired: T;
  detect: (candidate: T) => boolean;
}

export interface MutationEvaluationReport extends DeterministicEvaluationReport {
  name: string;
  baselineDetected: boolean;
  mutationDetected: boolean;
  repairedDetected: boolean;
}

export function evaluateMutationCase<T>(input: MutationEvaluationInput<T>): MutationEvaluationReport {
  const baselineDetected = input.detect(input.baseline);
  const mutationDetected = input.detect(input.mutated);
  const repairedDetected = input.detect(input.repaired);
  const violations: DeterministicViolation[] = [];
  if (baselineDetected) {
    violations.push({
      code: 'mutation-baseline-false-positive',
      message: 'Baseline fixture was reported as invalid.',
      path: 'baseline',
      expected: false,
      actual: true
    });
  }
  if (!mutationDetected) {
    violations.push({
      code: 'mutation-not-detected',
      message: 'Mutated fixture was not reported as invalid.',
      path: 'mutated',
      expected: true,
      actual: false
    });
  }
  if (repairedDetected) {
    violations.push({
      code: 'mutation-repair-false-positive',
      message: 'Repaired fixture was still reported as invalid.',
      path: 'repaired',
      expected: false,
      actual: true
    });
  }
  const report = createReport(violations, {
    baselineDetected: baselineDetected ? 1 : 0,
    mutationDetected: mutationDetected ? 1 : 0,
    repairedDetected: repairedDetected ? 1 : 0
  });
  return {
    ...report,
    name: input.name,
    baselineDetected,
    mutationDetected,
    repairedDetected
  };
}

export function evaluateMutationCases<T>(inputs: readonly MutationEvaluationInput<T>[]): MutationEvaluationReport[] {
  return inputs.map((input) => evaluateMutationCase(input));
}

export const evaluateMutation = evaluateMutationCase;

export class MutationEvaluator {
  public evaluate<T>(input: MutationEvaluationInput<T>): MutationEvaluationReport {
    return evaluateMutationCase(input);
  }
}
