import type { TypographyOptions } from '@inkpi/protocol';

export const DEFAULT_CHINESE_TYPOGRAPHY: TypographyOptions = {
  enabled: true,
  indentString: '\u3000\u3000', // 2 fullwidth spaces
  preventPunctuationAtLineStart: true
};

export function formatChineseTypography(text: string, options: Partial<TypographyOptions> = DEFAULT_CHINESE_TYPOGRAPHY): string {
  if (options.enabled === false) return text;
  const indent = options.indentString ?? DEFAULT_CHINESE_TYPOGRAPHY.indentString ?? '\u3000\u3000';

  const lines = text.split('\n');
  let inCodeBlock = false;

  const formattedLines = lines.map((line) => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      return line;
    }
    if (inCodeBlock || !trimmed) return line;

    // Skip Markdown headings, list items, quotes, screenplay scene headers
    if (/^(#{1,6}\s|[>*\-+]\s|\d+\.\s|INT\.|EXT\.|内景|外景|第[0-9一二三四五六七八九十]+[场幕章回]\s)/i.test(trimmed)) {
      return trimmed;
    }


    // If it already has indentation, normalize it
    const cleanContent = trimmed.replace(/^[\u3000\s]+/, '');
    return indent + cleanContent;
  });

  return formattedLines.join('\n');
}


export function formatWesternTypography(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/[ ]{2,}/g, ' '))
    .join('\n');
}

export function formatTypography(
  text: string,
  options: Partial<TypographyOptions> & { mode?: 'chinese' | 'western' | 'none' } = { mode: 'chinese' }
): string {
  if (options.enabled === false || options.mode === 'none') {
    return text;
  }
  if (options.mode === 'western') {
    return formatWesternTypography(text);
  }
  return formatChineseTypography(text, options);
}
