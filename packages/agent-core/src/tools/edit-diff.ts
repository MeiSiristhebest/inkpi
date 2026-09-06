/**
 * 工业级文本局部修改与模糊容错差异计算引擎 (Fuzzy Text Replacement Engine)
 * 1:1 承载 pi-main coding-agent 的核心算法：
 * 采用“归一化查找 + 变动行跨度感知 + 未变动行原貌严格保留 (Preserving Unchanged Lines)”架构。
 */

export interface DiffFuzzyMatchResult {
  found: boolean;
  index: number;
  matchLength: number;
  usedFuzzyMatch: boolean;
  contentForReplacement: string;
}

export function detectLineEnding(content: string): '\r\n' | '\n' {
  const crlfIdx = content.indexOf('\r\n');
  const lfIdx = content.indexOf('\n');
  if (lfIdx === -1) return '\n';
  if (crlfIdx === -1) return '\n';
  return crlfIdx < lfIdx ? '\r\n' : '\n';
}

export function normalizeToLF(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function restoreLineEndings(text: string, ending: '\r\n' | '\n'): string {
  return ending === '\r\n' ? text.replace(/\n/g, '\r\n') : text;
}

/**
 * 模糊归一化算法（完全对齐 pi-main 的标准化流水线）：
 * - Unicode NFKC 兼容分解；
 * - 剥离每行行尾空格；
 * - 中英文智能引号、弯引号统一转为 ASCII 引号；
 * - 全角标点、特殊破折号归一化；
 * - 全角空格 \u3000 及各种 Unicode 空格转为标准半角空格。
 */
export function normalizeForFuzzyMatch(text: string): string {
  return text
    .normalize('NFKC')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
    .replace(/，/g, ',')
    .replace(/。/g, '.')
    .replace(/：/g, ':')
    .replace(/；/g, ';')
    .replace(/？/g, '?')
    .replace(/！/g, '!')
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' ');
}

export function splitLinesWithEndings(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+/g) ?? [];
}

interface LineSpan {
  start: number;
  end: number;
}

interface TextReplacement {
  matchIndex: number;
  matchLength: number;
  newText: string;
}

function getLineSpans(content: string): LineSpan[] {
  let offset = 0;
  return splitLinesWithEndings(content).map((line) => {
    const span = { start: offset, end: offset + line.length };
    offset = span.end;
    return span;
  });
}

function getReplacementLineRange(
  lines: LineSpan[],
  replacement: TextReplacement
): { startLine: number; endLine: number } {
  const replacementStart = replacement.matchIndex;
  const replacementEnd = replacement.matchIndex + replacement.matchLength;

  let startLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (replacementStart >= line.start && replacementStart < line.end) {
      startLine = i;
      break;
    }
  }
  if (startLine === -1) {
    throw new Error('Replacement range is outside the base content.');
  }

  let endLine = startLine;
  while (endLine < lines.length && lines[endLine].end < replacementEnd) {
    endLine++;
  }
  if (endLine >= lines.length) {
    throw new Error('Replacement range is outside the base content.');
  }

  return { startLine, endLine: endLine + 1 };
}

function applyReplacements(content: string, replacements: TextReplacement[], offset = 0): string {
  let result = content;
  for (let i = replacements.length - 1; i >= 0; i--) {
    const replacement = replacements[i];
    const matchIndex = replacement.matchIndex - offset;
    result =
      result.substring(0, matchIndex) + replacement.newText + result.substring(matchIndex + replacement.matchLength);
  }
  return result;
}

/**
 * 在模糊替换的同时，100% 保护未变动行的原始字符、标点与格式（对齐 pi-main）
 */
export function applyReplacementsPreservingUnchangedLines(
  originalContent: string,
  baseContent: string,
  replacements: TextReplacement[]
): string {
  const originalLines = splitLinesWithEndings(originalContent);
  const baseLines = getLineSpans(baseContent);
  if (originalLines.length !== baseLines.length) {
    // 若行数不同则退化为直接替换
    return applyReplacements(baseContent, replacements);
  }

  const groups: Array<{ startLine: number; endLine: number; replacements: TextReplacement[] }> = [];
  const sortedReplacements = [...replacements].sort((a, b) => a.matchIndex - b.matchIndex);
  for (const replacement of sortedReplacements) {
    const range = getReplacementLineRange(baseLines, replacement);
    const current = groups[groups.length - 1];
    if (current && range.startLine < current.endLine) {
      current.endLine = Math.max(current.endLine, range.endLine);
      current.replacements.push(replacement);
      continue;
    }
    groups.push({ ...range, replacements: [replacement] });
  }

  let originalLineIndex = 0;
  let result = '';
  for (const group of groups) {
    result += originalLines.slice(originalLineIndex, group.startLine).join('');

    const groupStartOffset = baseLines[group.startLine].start;
    const groupEndOffset = baseLines[group.endLine - 1].end;
    result += applyReplacements(
      baseContent.slice(groupStartOffset, groupEndOffset),
      group.replacements,
      groupStartOffset
    );
    originalLineIndex = group.endLine;
  }
  result += originalLines.slice(originalLineIndex).join('');
  return result;
}

/**
 * 模糊查找目标文本位置
 */
export function fuzzyFindText(content: string, oldText: string): DiffFuzzyMatchResult {
  // 1. 优先尝试精准匹配（Exact match）
  const exactIndex = content.indexOf(oldText);
  if (exactIndex !== -1) {
    return {
      found: true,
      index: exactIndex,
      matchLength: oldText.length,
      usedFuzzyMatch: false,
      contentForReplacement: content
    };
  }

  // 2. 尝试模糊匹配（在归一化空间内匹配）
  const fuzzyContent = normalizeForFuzzyMatch(content);
  const fuzzyOldText = normalizeForFuzzyMatch(oldText);
  const fuzzyIndex = fuzzyContent.indexOf(fuzzyOldText);

  if (fuzzyIndex === -1) {
    return {
      found: false,
      index: -1,
      matchLength: 0,
      usedFuzzyMatch: false,
      contentForReplacement: content
    };
  }

  return {
    found: true,
    index: fuzzyIndex,
    matchLength: fuzzyOldText.length,
    usedFuzzyMatch: true,
    contentForReplacement: fuzzyContent
  };
}

/**
 * 执行原子替换并完美保留未修改行的格式
 */
export function applyFuzzyTextEdit(
  originalContent: string,
  edit: { oldText: string; newText: string }
): { success: boolean; newContent: string; error?: string } {
  const lineEnding = detectLineEnding(originalContent);
  const contentLF = normalizeToLF(originalContent);
  const oldTextLF = normalizeToLF(edit.oldText);
  const newTextLF = normalizeToLF(edit.newText);

  const match = fuzzyFindText(contentLF, oldTextLF);
  if (!match.found) {
    return {
      success: false,
      newContent: originalContent,
      error: 'Could not find oldText in document. Verify lines, punctuation, and whitespace.'
    };
  }

  let replacedLF: string;
  if (match.usedFuzzyMatch) {
    const fuzzyBase = normalizeForFuzzyMatch(contentLF);
    replacedLF = applyReplacementsPreservingUnchangedLines(contentLF, fuzzyBase, [
      {
        matchIndex: match.index,
        matchLength: match.matchLength,
        newText: newTextLF
      }
    ]);
  } else {
    const before = contentLF.slice(0, match.index);
    const after = contentLF.slice(match.index + match.matchLength);
    replacedLF = before + newTextLF + after;
  }

  return {
    success: true,
    newContent: restoreLineEndings(replacedLF, lineEnding)
  };
}
