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
  const formattedLines = lines.map((line) => {
    const trimmed = line.trimStart();
    if (!trimmed) return '';

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
