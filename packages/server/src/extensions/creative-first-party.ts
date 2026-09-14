import { type TaskHandler, type TaskHandlerContext, WorkflowCoordinator } from '@inkpi/agent-core';
import type { AgentTool, ToolResult } from '@inkpi/protocol';
import type { RuntimeExtensionDescriptor } from '../first-party-plugin-runtime.js';

/**
 * Creative first-party implementations deliberately live behind the Server
 * extension boundary. They consume serialized input and return results; they
 * do not select a provider, own a prompt registry, or mutate authoritative
 * creative state.
 */
export const CREATIVE_FIRST_PARTY_EXTENSION_ID = 'creative-first-party';

export const CREATIVE_FIRST_PARTY_TOOL_NAMES = [
  'plugin.diff-reviewer.compute',
  'plugin.memory-palace.search',
  'plugin.press-forge.format',
  'plugin.scrapbook-recycler.recommend'
] as const;

export const CREATIVE_FIRST_PARTY_WORKFLOW_KINDS = [
  'plugin.multiverse-whatif.workflow',
  'plugin.storyboard-gen.workflow'
] as const;

export function createCreativeFirstPartyExtension(): RuntimeExtensionDescriptor {
  return {
    id: CREATIVE_FIRST_PARTY_EXTENSION_ID,
    tools: createCreativeTools(),
    workflows: createCreativeWorkflowHandlers(),
    toolRegistration: {
      source: 'first-party-plugin-runtime',
      capabilities: ['first-party-plugin', 'offline']
    }
  };
}

function createCreativeTools(): AgentTool[] {
  return [
    {
      name: CREATIVE_FIRST_PARTY_TOOL_NAMES[0],
      label: 'Diff Reviewer',
      description: 'Compute a structured, reviewable line diff between original and proposed text.',
      parameters: {
        type: 'object',
        properties: {
          oldText: { type: 'string' },
          newText: { type: 'string' }
        },
        required: ['oldText', 'newText']
      },
      executionMode: 'sequential',
      replay: 'safe',
      execute: async (_toolCallId, params, signal) => {
        assertNotAborted(signal);
        const input = asRecord(params);
        return toToolResult(
          computeLineDiff(requireString(input.oldText, 'oldText'), requireString(input.newText, 'newText'))
        );
      }
    },
    {
      name: CREATIVE_FIRST_PARTY_TOOL_NAMES[1],
      label: 'Memory Palace',
      description: 'Search canonical entities and their chapter occurrences in Runtime-owned data.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          entities: { type: 'array', items: { type: 'object' } },
          chapters: { type: 'array', items: { type: 'object' } }
        },
        required: ['query', 'entities', 'chapters']
      },
      executionMode: 'sequential',
      replay: 'safe',
      execute: async (_toolCallId, params, signal) => {
        assertNotAborted(signal);
        const input = asRecord(params);
        return toToolResult(
          searchEntityOccurrences(
            requireString(input.query, 'query'),
            requireRecords(input.entities, 'entities'),
            requireRecords(input.chapters, 'chapters')
          )
        );
      }
    },
    {
      name: CREATIVE_FIRST_PARTY_TOOL_NAMES[2],
      label: 'Press Forge',
      description: 'Format chapter text with an explicit publication preset and return warnings.',
      parameters: {
        type: 'object',
        properties: {
          rawContent: { type: 'string' },
          options: { type: 'object' }
        },
        required: ['rawContent']
      },
      executionMode: 'sequential',
      replay: 'safe',
      execute: async (_toolCallId, params, signal) => {
        assertNotAborted(signal);
        const input = asRecord(params);
        return toToolResult(
          formatPressText(
            requireString(input.rawContent, 'rawContent'),
            input.options === undefined ? undefined : asRecord(input.options)
          )
        );
      }
    },
    {
      name: CREATIVE_FIRST_PARTY_TOOL_NAMES[3],
      label: 'Scrapbook Recycler',
      description: 'Rank reusable deleted fragments against the current writing context.',
      parameters: {
        type: 'object',
        properties: {
          contextText: { type: 'string' },
          fragments: { type: 'array', items: { type: 'object' } },
          topK: { type: 'integer', minimum: 1 }
        },
        required: ['contextText', 'fragments']
      },
      executionMode: 'sequential',
      replay: 'safe',
      execute: async (_toolCallId, params, signal) => {
        assertNotAborted(signal);
        const input = asRecord(params);
        const topK = input.topK === undefined ? 5 : requireInteger(input.topK, 'topK');
        return toToolResult(
          recommendScrapbookFragments(
            requireString(input.contextText, 'contextText'),
            requireRecords(input.fragments, 'fragments'),
            topK
          )
        );
      }
    }
  ];
}

function createCreativeWorkflowHandlers(): TaskHandler[] {
  return [
    createWorkflowHandler('multiverse-whatif', CREATIVE_FIRST_PARTY_WORKFLOW_KINDS[0], (input) =>
      simulateMultiverse(input)
    ),
    createWorkflowHandler('storyboard-gen', CREATIVE_FIRST_PARTY_WORKFLOW_KINDS[1], (input) => extractStoryboard(input))
  ];
}

function createWorkflowHandler(pluginId: string, kind: string, executeInput: (input: unknown) => unknown): TaskHandler {
  const stageId = `plugin.${pluginId}.runtime`;
  return {
    id: `first-party.workflow.${pluginId}`,
    kinds: [kind],
    async execute(context: TaskHandlerContext) {
      await context.saveCheckpoint('input-validated', { pluginId });
      await pauseAfterCheckpointForFaultInjection(context.signal);
      context.reportProgress(0.1);
      const coordinator = new WorkflowCoordinator({
        stages: [
          {
            id: stageId,
            name: `${pluginId} Runtime Workflow`,
            role: {
              role: `plugin:${pluginId}`,
              name: `${pluginId} Runtime Workflow`,
              systemPrompt: 'Execute the registered deterministic plugin workflow and return JSON.'
            },
            executor: async (workflowContext, signal) => {
              assertNotAborted(signal);
              const result = executeInput(workflowContext.metadata?.pluginInput);
              return { text: JSON.stringify(result) };
            }
          }
        ]
      });
      const workflowResult = await coordinator.runWorkflow({
        userPrompt: context.task.intent ?? '',
        metadata: { pluginInput: context.task.input.payload }
      });
      context.reportProgress(1);
      const stageOutput = workflowResult.stageOutputs[stageId];
      if (!stageOutput) throw new Error(`Runtime workflow '${pluginId}' returned no output`);
      return {
        output: { format: 'structured', data: JSON.parse(stageOutput) },
        provenance: {
          pluginId,
          runtimeClass: 'workflow',
          runtimeTarget: 'runtime-workflow',
          workflowStage: stageId
        }
      };
    }
  };
}

/**
 * Keep the packaged crash-recovery acceptance deterministic. This hook is
 * inert unless an explicit test-only environment variable is supplied by the
 * harness, and it is abort-aware so it cannot delay normal cancellation.
 */
async function pauseAfterCheckpointForFaultInjection(signal?: AbortSignal): Promise<void> {
  const configured = Number(process.env.INKPI_TEST_PAUSE_AFTER_CHECKPOINT_MS ?? 0);
  if (!Number.isFinite(configured) || configured <= 0) return;
  const durationMs = Math.min(Math.floor(configured), 30_000);
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      const error = new Error('Plugin Runtime operation was aborted');
      error.name = 'AbortError';
      reject(error);
    };
    const done = () => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    const timer = setTimeout(done, durationMs);
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  assertNotAborted(signal);
}

function computeLineDiff(oldText: string, newText: string): Record<string, unknown> {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  if (oldText === newText) {
    return { hunks: [], stats: { additions: 0, deletions: 0, unmodified: oldLines.length } };
  }

  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) {
    suffix += 1;
  }

  const contextBefore = Math.min(2, prefix);
  const contextAfter = Math.min(2, suffix);
  const oldChangedEnd = oldLines.length - suffix;
  const newChangedEnd = newLines.length - suffix;
  const hunkStart = prefix - contextBefore;
  const lines = [
    ...oldLines.slice(hunkStart, prefix).map((line) => ` ${line}`),
    ...oldLines.slice(prefix, oldChangedEnd).map((line) => `-${line}`),
    ...newLines.slice(prefix, newChangedEnd).map((line) => `+${line}`),
    ...oldLines.slice(oldChangedEnd, oldChangedEnd + contextAfter).map((line) => ` ${line}`)
  ];
  let oldLineNumber = hunkStart + 1;
  let newLineNumber = hunkStart + 1;
  const lineChanges = lines.map((line) => {
    const marker = line[0];
    const content = line.slice(1);
    if (marker === '+') return { type: 'added', newLineNumber: newLineNumber++, content };
    if (marker === '-') return { type: 'removed', oldLineNumber: oldLineNumber++, content };
    return {
      type: 'unchanged',
      oldLineNumber: oldLineNumber++,
      newLineNumber: newLineNumber++,
      content
    };
  });

  return {
    hunks: [
      {
        id: `hunk-0-${hunkStart + 1}-${prefix + 1}`,
        oldStartLine: hunkStart + 1,
        oldLineCount: oldChangedEnd - hunkStart + contextAfter,
        newStartLine: hunkStart + 1,
        newLineCount: newChangedEnd - hunkStart + contextAfter,
        lines,
        lineChanges,
        resolution: 'pending'
      }
    ],
    stats: {
      additions: newChangedEnd - prefix,
      deletions: oldChangedEnd - prefix,
      unmodified: prefix + suffix
    }
  };
}

function searchEntityOccurrences(
  query: string,
  entities: Record<string, unknown>[],
  chapters: Record<string, unknown>[]
): unknown[] {
  const normalizedQuery = query.trim().toLowerCase();
  const sortedChapters = [...chapters].sort((left, right) => numberValue(left.order) - numberValue(right.order));
  return entities
    .filter((entity) => {
      if (!normalizedQuery) return true;
      const name = stringValue(entity.name);
      const aliases = stringArray(entity.aliases);
      const summary = stringValue(entity.summary);
      return (
        name.toLowerCase().includes(normalizedQuery) ||
        aliases.some((alias) => alias.toLowerCase().includes(normalizedQuery)) ||
        summary.toLowerCase().includes(normalizedQuery)
      );
    })
    .map((entity) => {
      const name = requireString(entity.name, 'entity.name');
      const aliases = stringArray(entity.aliases);
      const occurrences: Array<{ chapter: Record<string, unknown>; snippet: string }> = [];
      for (const chapter of sortedChapters) {
        const text = stringValue(chapter.content);
        for (const term of [name, ...aliases].filter(Boolean)) {
          const index = text.indexOf(term);
          if (index < 0) continue;
          const start = Math.max(0, index - 30);
          const end = Math.min(text.length, index + term.length + 30);
          occurrences.push({
            chapter,
            snippet: `${start > 0 ? '...' : ''}${text.slice(start, end).replace(/\n/g, ' ')}${end < text.length ? '...' : ''}`
          });
          break;
        }
      }
      const first = occurrences[0]?.chapter;
      const last = occurrences.at(-1)?.chapter;
      let relevanceScore = 50;
      if (name.toLowerCase() === normalizedQuery) relevanceScore = 100;
      else if (name.toLowerCase().includes(normalizedQuery)) relevanceScore = 85;
      else if (aliases.some((alias) => alias.toLowerCase() === normalizedQuery)) relevanceScore = 90;
      return {
        entityId: requireString(entity.id, 'entity.id'),
        entityName: name,
        category: stringValue(entity.category) || 'entity',
        relevanceScore,
        totalOccurrences: occurrences.length,
        firstAppearedChapter: first
          ? { id: stringValue(first.id), title: stringValue(first.title), order: numberValue(first.order) }
          : undefined,
        lastAppearedChapter: last
          ? { id: stringValue(last.id), title: stringValue(last.title), order: numberValue(last.order) }
          : undefined,
        recentSnippets: occurrences
          .slice(-3)
          .map(({ chapter, snippet }) => `[第${numberValue(chapter.order)}章 ${stringValue(chapter.title)}] ${snippet}`)
      };
    })
    .sort(
      (left, right) => right.relevanceScore - left.relevanceScore || right.totalOccurrences - left.totalOccurrences
    );
}

function formatPressText(rawContent: string, rawOptions?: Record<string, unknown>): Record<string, unknown> {
  const options = rawOptions ?? {};
  const preset = stringValue(options.presetId);
  const defaults = presetDefaults(preset);
  let text = rawContent
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\u200B|\u200C|\u200D|\uFEFF/g, '');
  let fixedPunctuationCount = 0;
  const fixPunctuation = booleanValue(options.fixPunctuation, defaults.fixPunctuation);
  if (fixPunctuation) {
    const initial = text;
    text = text
      .replace(/,/g, '，')
      .replace(/\?/g, '？')
      .replace(/!/g, '！')
      .replace(/:/g, '：')
      .replace(/;/g, '；')
      .replace(/\.{3,}/g, '……')
      .replace(/-{2,}/g, '——');
    if (text !== initial) fixedPunctuationCount = 1;
  }
  const dialogueStyle = stringValue(options.dialogueStyle) || defaults.dialogueStyle;
  if (dialogueStyle === 'bracket') text = text.replace(/“/g, '「').replace(/”/g, '」');
  const paragraphs = text
    .split('\n')
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
  const indentSpaces = integerValue(options.indentSpaces, defaults.indentSpaces);
  const paragraphSpacing = integerValue(options.paragraphSpacing, defaults.paragraphSpacing);
  const formattedParagraphs = paragraphs.map((paragraph) => `${'　'.repeat(Math.max(0, indentSpaces))}${paragraph}`);
  const formattedText = formattedParagraphs.join('\n'.repeat(Math.max(0, paragraphSpacing) + 1));
  const warnings: string[] = [];
  if (booleanValue(options.checkSensitiveWords, defaults.checkSensitiveWords)) {
    const sensitiveWords = stringArray(options.sensitiveWords);
    for (const word of sensitiveWords.length > 0 ? sensitiveWords : DEFAULT_SENSITIVE_WORDS) {
      if (formattedText.includes(word)) warnings.push(`Sensitive word detected: ${word}`);
    }
  }
  return {
    formattedText,
    lineCount: formattedParagraphs.length,
    characterCount: formattedText.replace(/\s+/g, '').length,
    warnings,
    fixedPunctuationCount
  };
}

function presetDefaults(preset: string): {
  indentSpaces: number;
  paragraphSpacing: number;
  dialogueStyle: string;
  fixPunctuation: boolean;
  checkSensitiveWords: boolean;
} {
  if (preset === 'fanqie-compact')
    return {
      indentSpaces: 0,
      paragraphSpacing: 1,
      dialogueStyle: 'standard-quotes',
      fixPunctuation: true,
      checkSensitiveWords: true
    };
  if (preset === 'print-typeset')
    return {
      indentSpaces: 2,
      paragraphSpacing: 0,
      dialogueStyle: 'standard-quotes',
      fixPunctuation: true,
      checkSensitiveWords: false
    };
  return {
    indentSpaces: 2,
    paragraphSpacing: 1,
    dialogueStyle: 'standard-quotes',
    fixPunctuation: true,
    checkSensitiveWords: true
  };
}

function recommendScrapbookFragments(
  contextText: string,
  fragments: Record<string, unknown>[],
  topK: number
): unknown[] {
  if (!contextText || fragments.length === 0) return [];
  const queryTokens = tokenize(contextText);
  if (queryTokens.length === 0) return [];
  const queryFrequency = frequencies(queryTokens);
  const recommendations: Array<Record<string, unknown>> = [];
  for (const fragment of fragments) {
    if (fragment.isReused === true) continue;
    const fragmentTokens = tokenize(stringValue(fragment.snippet));
    const fragmentFrequency = frequencies(fragmentTokens);
    let dotProduct = 0;
    const matchedKeywords: string[] = [];
    for (const [word, count] of queryFrequency) {
      const fragmentCount = fragmentFrequency.get(word);
      if (fragmentCount) {
        dotProduct += count * fragmentCount;
        matchedKeywords.push(word);
      }
    }
    const normQuery = Math.sqrt([...queryFrequency.values()].reduce((sum, count) => sum + count * count, 0));
    const normFragment = Math.sqrt([...fragmentFrequency.values()].reduce((sum, count) => sum + count * count, 0));
    const similarity = normQuery > 0 && normFragment > 0 ? dotProduct / (normQuery * normFragment) : 0;
    if (similarity > 0.05) {
      recommendations.push({ fragment, similarityScore: Math.round(similarity * 100) / 100, matchedKeywords });
    }
  }
  return recommendations
    .sort((left, right) => numberValue(right.similarityScore) - numberValue(left.similarityScore))
    .slice(0, Math.max(1, topK));
}

function simulateMultiverse(input: unknown): Record<string, unknown> {
  const payload = asRecord(input);
  const chapters = requireRecords(payload.canonChapters, 'canonChapters').map((chapter) => ({
    index: requireInteger(chapter.index, 'canonChapters.index'),
    title: stringValue(chapter.title),
    summary: stringValue(chapter.summary),
    entities: stringArray(chapter.entities)
  }));
  const forkChapterIndex = requireInteger(payload.forkChapterIndex, 'forkChapterIndex');
  const premise = requireString(payload.divergencePremise, 'divergencePremise');
  const nodes: Record<string, unknown>[] = [];
  const butterflyEffects: Record<string, unknown>[] = [];
  const divergenceCurve: Record<string, number>[] = [];
  for (const chapter of chapters) {
    if (chapter.index < forkChapterIndex) {
      nodes.push({
        chapterIndex: chapter.index,
        chapterTitle: chapter.title,
        eventSummary: chapter.summary,
        divergenceLevel: 0,
        butterflyEffects: []
      });
      divergenceCurve.push({ chapter: chapter.index, divergencePercent: 0 });
      continue;
    }
    if (chapter.index === forkChapterIndex) {
      nodes.push({
        chapterIndex: chapter.index,
        chapterTitle: `${chapter.title} (branch fork)`,
        eventSummary: `[What-If] ${premise}`,
        divergenceLevel: 0.35,
        butterflyEffects: [`[Fork] ${premise}`]
      });
      divergenceCurve.push({ chapter: chapter.index, divergencePercent: 35 });
      butterflyEffects.push({
        chapterIndex: chapter.index,
        rippleFactor: 0.35,
        description: premise,
        affectedCharacters: chapter.entities.slice(0, 2)
      });
      continue;
    }
    const delta = chapter.index - forkChapterIndex;
    const divergence = Math.min(1, Math.round((0.35 + 0.18 * Math.log(1 + delta)) * 100) / 100);
    const chapterEffects =
      divergence >= 0.7
        ? ['[Worldline] Key allies change allegiance or fate']
        : divergence >= 0.5
          ? ['[Butterfly] The crisis arrives earlier and breaks the causal chain']
          : ['[Local divergence] The protagonist pays a higher cost'];
    nodes.push({
      chapterIndex: chapter.index,
      chapterTitle: `${chapter.title} (parallel branch)`,
      eventSummary: `Divergence from chapter ${forkChapterIndex}: ${chapterEffects[0]}`,
      divergenceLevel: divergence,
      butterflyEffects: chapterEffects
    });
    divergenceCurve.push({ chapter: chapter.index, divergencePercent: Math.round(divergence * 100) });
    butterflyEffects.push({
      chapterIndex: chapter.index,
      rippleFactor: divergence,
      description: chapterEffects[0],
      affectedCharacters: chapter.entities
    });
  }
  return {
    branchId: `branch_${forkChapterIndex}`,
    branchName: `Parallel branch: ${premise.slice(0, 15)}...`,
    forkChapterIndex,
    divergenceCurve,
    nodes,
    butterflyEffects
  };
}

function extractStoryboard(input: unknown): Record<string, unknown> {
  const payload = asRecord(input);
  const chapterId = requireString(payload.chapterId, 'chapterId');
  const chapterTitle = stringValue(payload.chapterTitle) || 'Chapter 1';
  const chapterText = requireString(payload.chapterText, 'chapterText');
  const context = asRecord(payload.context);
  const protagonist = stringValue(context.protagonist) || 'Protagonist';
  const antagonist = stringValue(context.antagonist) || 'Antagonist';
  const lines = chapterText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 5);
  const action = lines.find((line) => /[剑刀斩杀掌拳雷火轰]/.test(line)) || lines[0] || '双方对峙';
  const frames = [
    {
      id: `shot_1_${chapterId}`,
      shotOrder: 1,
      shotType: 'establishing_wide',
      shotLabel: '[1] Establishing wide',
      description: `${chapterTitle}: ${protagonist} and ${antagonist} face the changing battlefield.`,
      compositionGuide: 'rule_of_thirds',
      lightingMood: 'storm light',
      visualPrompt: `cinematic establishing shot, ${protagonist} vs ${antagonist}`
    },
    {
      id: `shot_2_${chapterId}`,
      shotOrder: 2,
      shotType: 'medium_confrontation',
      shotLabel: '[2] Medium confrontation',
      description: `${antagonist} presses the attack while ${protagonist} holds the line.`,
      compositionGuide: 'leading_sightlines',
      lightingMood: 'split warm and cool light',
      visualPrompt: `cinematic confrontation, ${protagonist} facing ${antagonist}`
    },
    {
      id: `shot_3_${chapterId}`,
      shotOrder: 3,
      shotType: 'dutch_closeup',
      shotLabel: '[3] Dutch close-up',
      description: `${protagonist} finds the reversal in the instant before defeat.`,
      compositionGuide: 'diagonal_impact',
      lightingMood: 'light breaks through darkness',
      visualPrompt: `dramatic dutch angle close-up of ${protagonist}`
    },
    {
      id: `shot_4_${chapterId}`,
      shotOrder: 4,
      shotType: 'impact_wide',
      shotLabel: '[4] Impact wide',
      description: `The conflict settles after the decisive impact: ${action.slice(0, 45)}`,
      compositionGuide: 'center_monumental',
      lightingMood: 'dawn after the storm',
      visualPrompt: `monumental impact wide shot, ${protagonist} standing after the clash`
    }
  ];
  return {
    sceneTitle: `${chapterTitle} climax storyboard`,
    coreConflict: `${protagonist} versus ${antagonist}: ${action.slice(0, 45)}`,
    frames,
    suggestedCharacters: [
      {
        characterId: 'c_main',
        characterName: protagonist,
        visualFeatures: `${protagonist}: determined lead`,
        stableDiffusionPrompt: `cinematic character design ${protagonist}`
      },
      {
        characterId: 'c_rival',
        characterName: antagonist,
        visualFeatures: `${antagonist}: threatening rival`,
        stableDiffusionPrompt: `cinematic character design ${antagonist}`
      }
    ]
  };
}

function toToolResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) ?? 'null' }], details: value };
}

function splitLines(value: string): string[] {
  return value.split(/\r?\n/);
}

function tokenize(value: string): string[] {
  const cleaned = value.replace(/[，。！？；、“”’（）《》\s\r\n]/g, ' ');
  const rawTokens = cleaned.split(' ').filter((token) => token.length >= 2);
  const grams: string[] = [];
  for (const token of rawTokens) {
    grams.push(token);
    if (token.length >= 4) {
      for (let index = 0; index < token.length - 1; index += 1) grams.push(token.slice(index, index + 2));
    }
  }
  return grams;
}

function frequencies(tokens: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1);
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Plugin runtime input must be an object');
  return value as Record<string, unknown>;
}

function requireRecords(value: unknown, field: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  return value.map((item) => asRecord(item));
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

function requireInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${field} must be an integer`);
  return value;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberValue(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function integerValue(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Plugin Runtime operation was aborted');
  error.name = 'AbortError';
  throw error;
}

const DEFAULT_SENSITIVE_WORDS = ['中南海', '领导人', '暴动', '分裂', '毒品', '邪教', '违禁药品'];
