/**
 * 终端长文本/全屏转录线性搜索索引器 (对齐上游 v0.85.0 PR #8800)
 *
 * 优化点：
 * 1. 现实转录主要是可打印 ASCII，直接按非空白字符 run 连续跨度批量索引，避免对每个字符分配 AST/映射对象；
 * 2. 缓存语料 corpus 与搜索结果，在行内容未变动时只在 query 改变时重新正则匹配；
 * 3. 搜索复杂度在大文本下由 O(N^2) 降至严格线性 O(N)。
 */

import { visibleWidth } from './render.js';

export interface AltScreenSearchSegment {
  row: number;
  startCol: number;
  endCol: number;
}

export interface AltScreenSearchMatch {
  segments: AltScreenSearchSegment[];
}

export interface SearchSourceSpan {
  textStart: number;
  textEnd: number;
  row: number;
  startCol: number;
  endCol: number;
  linearColumns: boolean;
}

export interface SearchCorpus {
  text: string;
  spans: SearchSourceSpan[];
}

export interface AltScreenSearchResult {
  matches: AltScreenSearchMatch[];
  changed: boolean;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

export function stripTerminalSequences(text: string): string {
  // 移除常见 ANSI 转移序列以获得纯文本坐标
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b_[^\x07]*\x07/g, '');
}

export function buildSearchCorpus(lines: readonly string[]): SearchCorpus {
  const chunks: string[] = [];
  const spans: SearchSourceSpan[] = [];
  let textLength = 0;
  let pendingSeparator = false;

  const appendSeparator = (): void => {
    if (!pendingSeparator) return;
    chunks.push(' ');
    textLength += 1;
    pendingSeparator = false;
  };

  for (let row = 0; row < lines.length; row++) {
    const line = stripTerminalSequences(lines[row] ?? '');
    let column = 0;

    if (PRINTABLE_ASCII.test(line)) {
      let index = 0;
      while (index < line.length) {
        if (line.charCodeAt(index) === 0x20) {
          if (textLength > 0) pendingSeparator = true;
          column += 1;
          index += 1;
          continue;
        }
        let end = index + 1;
        while (end < line.length && line.charCodeAt(end) !== 0x20) end += 1;
        appendSeparator();
        const text = line.slice(index, end);
        chunks.push(text);
        spans.push({
          textStart: textLength,
          textEnd: textLength + text.length,
          row,
          startCol: column,
          endCol: column + text.length,
          linearColumns: true
        });
        textLength += text.length;
        column += text.length;
        index = end;
      }
    } else {
      // 含有中文字符或全角字符时按分词/字符解析
      const chars = Array.from(line);
      for (const char of chars) {
        const width = visibleWidth(char);
        if (/^\s+$/u.test(char)) {
          if (textLength > 0) pendingSeparator = true;
          column += width;
          continue;
        }
        appendSeparator();
        chunks.push(char);
        spans.push({
          textStart: textLength,
          textEnd: textLength + char.length,
          row,
          startCol: column,
          endCol: column + width,
          linearColumns: false
        });
        textLength += char.length;
        column += width;
      }
    }
    if (textLength > 0) pendingSeparator = true;
  }

  return { text: chunks.join(''), spans };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function findSearchCorpusMatches(corpus: SearchCorpus, query: string): AltScreenSearchMatch[] {
  const normalizedQuery = query.trim();
  if (!normalizedQuery) return [];
  const expression = new RegExp(escapeRegExp(normalizedQuery), 'giu');
  const matches: AltScreenSearchMatch[] = [];
  let spanIndex = 0;

  for (const match of corpus.text.matchAll(expression)) {
    const start = match.index;
    const end = start + match[0].length;
    while (spanIndex < corpus.spans.length && (corpus.spans[spanIndex]?.textEnd ?? 0) <= start) {
      spanIndex += 1;
    }

    const segments: AltScreenSearchSegment[] = [];
    for (let index = spanIndex; index < corpus.spans.length; index++) {
      const span = corpus.spans[index]!;
      if (span.textStart >= end) break;
      if (span.textEnd <= start) continue;
      const startCol = span.linearColumns
        ? span.startCol + Math.max(start, span.textStart) - span.textStart
        : span.startCol;
      const endCol = span.linearColumns ? span.startCol + Math.min(end, span.textEnd) - span.textStart : span.endCol;
      const previous = segments[segments.length - 1];
      if (previous && previous.row === span.row && startCol <= previous.endCol) {
        previous.endCol = Math.max(previous.endCol, endCol);
      } else {
        segments.push({ row: span.row, startCol, endCol });
      }
    }
    while (spanIndex < corpus.spans.length && (corpus.spans[spanIndex]?.textEnd ?? 0) <= end) {
      spanIndex += 1;
    }
    if (segments.length > 0) matches.push({ segments });
  }

  return matches;
}

export class AltScreenSearchIndex {
  private sourceLines: string[] | undefined;
  private corpus: SearchCorpus | undefined;
  private normalizedQuery: string | undefined;
  private matches: AltScreenSearchMatch[] = [];

  public search(lines: readonly string[], query: string): AltScreenSearchResult {
    let sourceChanged = this.sourceLines?.length !== lines.length;
    if (!sourceChanged && this.sourceLines) {
      for (let index = 0; index < lines.length; index++) {
        if (this.sourceLines[index] === lines[index]) continue;
        sourceChanged = true;
        break;
      }
    }
    if (sourceChanged || !this.corpus) {
      this.sourceLines = Array.from(lines);
      this.corpus = buildSearchCorpus(lines);
    }

    const normalized = query.trim();
    const changed = sourceChanged || normalized !== this.normalizedQuery;
    if (changed) {
      this.normalizedQuery = normalized;
      this.matches = findSearchCorpusMatches(this.corpus, normalized);
    }
    return { matches: this.matches, changed };
  }
}
