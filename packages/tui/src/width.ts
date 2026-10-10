/**
 * 终端宽字符与 ANSI 转义序列安全切片与可见宽度计算
 * 支持中日韩汉字、全角标点、全角空格 \u3000、Emoji 以及 ANSI 样式保持。
 */

// ANSI Escape sequence regex
export const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_AT_POSITION_REGEX = new RegExp(ANSI_REGEX.source, 'y');
const MARK_REGEX = /^\p{Mark}$/u;
const GRAPHEME_SEGMENTER =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : undefined;

/**
 * 剥除 ANSI 控制符
 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

/**
 * 判断单字符是否为全角宽字符 (CJK 汉字、全角标点、全角符号、Emoji)
 */
export function isWideChar(codePoint: number): boolean {
  if (codePoint < 0x1100) return false;

  return (
    // Hangul Jamo
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    // CJK Radicals, Kangxi, Ideographic Description, CJK Symbols & Punctuation
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
    // Fullwidth ASCII Variants & Fullwidth Punctuation (e.g. 《》“”‘’——……)
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
    // CJK Unified Ideographs & Extensions
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2ceaf) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    // Fullwidth Ideographic Space (\u3000)
    codePoint === 0x3000 ||
    // Common Emojis and Symbols
    (codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

interface GraphemeToken {
  segment: string;
  prefix: string;
  raw: string;
  sourceEnd: number;
  width: number;
}

function* graphemeSegments(text: string): IterableIterator<{ segment: string; index: number }> {
  if (GRAPHEME_SEGMENTER) {
    for (const { segment, index } of GRAPHEME_SEGMENTER.segment(text)) {
      yield { segment, index };
    }
    return;
  }

  let index = 0;
  for (const segment of text) {
    yield { segment, index };
    index += segment.length;
  }
}

function widthOfGrapheme(segment: string): number {
  if (segment.includes('\ufe0f') || segment.includes('\u20e3')) return 2;

  let width = 0;
  for (const character of segment) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint === 0x200c ||
      codePoint === 0x200d ||
      (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
      (codePoint >= 0xe0100 && codePoint <= 0xe01ef) ||
      (codePoint >= 0x1f3fb && codePoint <= 0x1f3ff) ||
      (codePoint >= 0xe0020 && codePoint <= 0xe007f) ||
      MARK_REGEX.test(character)
    ) {
      continue;
    }
    width = Math.max(width, isWideChar(codePoint) ? 2 : 1);
  }
  return width;
}

function ansiAt(text: string, index: number): string | undefined {
  ANSI_AT_POSITION_REGEX.lastIndex = index;
  return ANSI_AT_POSITION_REGEX.exec(text)?.[0];
}

function tokenizeGraphemes(text: string): {
  tokens: GraphemeToken[];
  trailingAnsi: string;
} {
  const plainParts: string[] = [];
  const rawStarts: number[] = [];
  const rawEnds: number[] = [];
  let index = 0;

  while (index < text.length) {
    const ansi = ansiAt(text, index);
    if (ansi) {
      index += ansi.length;
      continue;
    }

    const codePoint = text.codePointAt(index)!;
    const length = codePoint > 0xffff ? 2 : 1;
    plainParts.push(text.slice(index, index + length));
    for (let unit = 0; unit < length; unit += 1) {
      rawStarts.push(index);
      rawEnds.push(index + length);
    }
    index += length;
  }

  const plainText = plainParts.join('');
  const tokens: GraphemeToken[] = [];
  let rawCursor = 0;
  for (const part of graphemeSegments(plainText)) {
    const rawStart = rawStarts[part.index];
    const rawEnd = rawEnds[part.index + part.segment.length - 1];
    const raw = text.slice(rawStart, rawEnd);
    tokens.push({
      segment: part.segment,
      prefix: text.slice(rawCursor, rawStart),
      raw,
      sourceEnd: rawEnd,
      width: widthOfGrapheme(part.segment)
    });
    rawCursor = rawEnd;
  }

  return { tokens, trailingAnsi: text.slice(rawCursor) };
}

function extractAnsiSequences(text: string): string {
  let result = '';
  let index = 0;
  while (index < text.length) {
    const ansi = ansiAt(text, index);
    if (ansi) {
      result += ansi;
      index += ansi.length;
      continue;
    }
    const codePoint = text.codePointAt(index)!;
    index += codePoint > 0xffff ? 2 : 1;
  }
  return result;
}

/**
 * 计算文本在终端中占据的物理列宽
 */
export function visibleWidth(text: string): number {
  if (!text) return 0;
  const clean = stripAnsi(text);
  let width = 0;
  for (const { segment } of graphemeSegments(clean)) width += widthOfGrapheme(segment);
  return width;
}

/** Wrap plain text at grapheme boundaries and retain only the trailing viewport rows. */
export function wrapTextToWidth(text: string, maxColumns: number, maxLines = Number.POSITIVE_INFINITY): string[] {
  const widthLimit = Math.floor(maxColumns);
  const lineLimit = Number.isFinite(maxLines) ? Math.max(0, Math.floor(maxLines)) : Number.POSITIVE_INFINITY;
  if (widthLimit <= 0 || lineLimit === 0) return [];

  const lines: string[] = [];
  const pushLine = (line: string): void => {
    if (lines.length >= lineLimit) lines.shift();
    lines.push(line);
  };

  let currentLine = '';
  let currentWidth = 0;
  for (const { segment } of graphemeSegments(text)) {
    if (segment === '\n' || segment === '\r' || segment === '\r\n') {
      pushLine(currentLine);
      currentLine = '';
      currentWidth = 0;
      continue;
    }

    const segmentWidth = widthOfGrapheme(segment);
    if (currentWidth > 0 && currentWidth + segmentWidth > widthLimit) {
      pushLine(currentLine);
      currentLine = '';
      currentWidth = 0;
    }
    currentLine += segment;
    currentWidth += segmentWidth;
  }

  if (currentLine.length > 0 || text.length === 0 || text.endsWith('\n') || text.endsWith('\r')) {
    pushLine(currentLine);
  }
  return lines;
}

/**
 * 在保持 ANSI 样式的前提下，按终端物理列宽进行精准切片
 */
export function sliceWithWidth(text: string, startCol: number, maxColumns: number): string {
  if (maxColumns <= 0) return '';
  let currentCol = 0;
  let result = '';
  let pendingAnsi = '';
  let selected = false;
  let truncated = false;
  const { tokens, trailingAnsi } = tokenizeGraphemes(text);

  for (const token of tokens) {
    if (currentCol < startCol) {
      pendingAnsi += token.prefix + extractAnsiSequences(token.raw);
      currentCol += token.width;
      continue;
    }

    if (currentCol - startCol + token.width > maxColumns) {
      truncated = true;
      break;
    }

    result += pendingAnsi + token.prefix + token.raw;
    pendingAnsi = '';
    selected = true;
    currentCol += token.width;
  }

  if (selected && !truncated) result += pendingAnsi + trailingAnsi;
  if (selected && /\x1b\[[0-9;]*m/.test(result) && !/\x1b\[(?:0;?)*m$/.test(result)) result += '\x1b[0m';
  return result;
}

/**
 * 将多行文本按指定物理宽度进行对齐与截断填充
 */
export function padOrTruncateLine(line: string, targetWidth: number, fillChar = ' '): string {
  const currentW = visibleWidth(line);
  if (currentW === targetWidth) return line;
  if (currentW > targetWidth) {
    return sliceWithWidth(line, 0, targetWidth);
  }
  return line + fillChar.repeat(targetWidth - currentW);
}
