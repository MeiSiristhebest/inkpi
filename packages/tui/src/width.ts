/**
 * 终端宽字符与 ANSI 转义序列安全切片与可见宽度计算
 * 支持中日韩汉字、全角标点、全角空格 \u3000、Emoji 以及 ANSI 样式保持。
 */

// ANSI Escape sequence regex
export const ANSI_REGEX = /\x1b\[[0-9;]*[a-zA-Z]|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

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
    (codePoint >= 0x1f300 && codePoint <= 0x1f9ff) ||
    (codePoint >= 0x2600 && codePoint <= 0x27bf)
  );
}

/**
 * 计算文本在终端中占据的物理列宽
 */
export function visibleWidth(text: string): number {
  if (!text) return 0;
  const clean = stripAnsi(text);
  let width = 0;

  for (let i = 0; i < clean.length; i++) {
    const code = clean.codePointAt(i)!;
    if (code > 0xffff) {
      i++; // Surrogate pair
    }
    width += isWideChar(code) ? 2 : 1;
  }

  return width;
}

/**
 * 在保持 ANSI 样式的前提下，按终端物理列宽进行精准切片
 */
export function sliceWithWidth(text: string, startCol: number, maxColumns: number): string {
  if (maxColumns <= 0) return '';
  let currentCol = 0;
  let result = '';
  let i = 0;
  let activeAnsi = '';

  while (i < text.length) {
    if (text.charCodeAt(i) === 0x1b) {
      // Extract full ANSI escape sequence
      const match = text
        .slice(i)
        .match(/^(\x1b\[[0-9;]*[a-zA-Z]|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/);
      if (match) {
        const ansiCode = match[0];
        activeAnsi += ansiCode;
        if (currentCol >= startCol && currentCol - startCol < maxColumns) {
          result += ansiCode;
        }
        i += ansiCode.length;
        continue;
      }
    }

    const codePoint = text.codePointAt(i)!;
    const charLen = codePoint > 0xffff ? 2 : 1;
    const char = text.slice(i, i + charLen);
    const charWidth = isWideChar(codePoint) ? 2 : 1;

    if (currentCol >= startCol && currentCol - startCol + charWidth <= maxColumns) {
      result += char;
    } else if (currentCol - startCol + charWidth > maxColumns && currentCol >= startCol) {
      // Cannot fit next wide char without overflowing
      break;
    }

    currentCol += charWidth;
    i += charLen;
  }

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
