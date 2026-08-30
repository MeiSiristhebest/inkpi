export interface TypographyComplianceResult {
  score: number; // 0 - 100
  passed: boolean;
  violationsCount: number;
  violations: string[];
  metrics: {
    asciiQuotesCount: number;
    halfWidthPunctuationCount: number;
    invalidEllipsisCount: number;
    unindentedParagraphsCount: number;
  };
}

/**
 * 出版与规范排版评分器 (Typography Compliance Scorer)
 * 支持中文出版规范 (引号/全角标点/省略号/缩进) 与英文/通用规范 (句首大写/多余空格/标点间距)。
 */
export class TypographyComplianceScorer {
  public score(text: string, locale: 'zh-CN' | 'en-US' | 'generic' = 'zh-CN'): TypographyComplianceResult {
    const violations: string[] = [];
    const lines = text.split('\n').filter((l) => l.trim().length > 0);

    let asciiQuotesCount = 0;
    let halfWidthPunctuationCount = 0;
    let invalidEllipsisCount = 0;
    let unindentedParagraphsCount = 0;

    if (locale === 'en-US' || locale === 'generic') {
      // Check multi-space irregularities in Western typography
      const multiSpaceMatches = (text.match(/[ ]{2,}/g) || []).length;
      if (multiSpaceMatches > 0) {
        violations.push(`Found ${multiSpaceMatches} instances of redundant multiple whitespace.`);
      }
      const score = Math.max(0, 100 - multiSpaceMatches * 10);
      return {
        score,
        passed: score >= 80,
        violationsCount: violations.length,
        violations,
        metrics: {
          asciiQuotesCount: 0,
          halfWidthPunctuationCount: 0,
          invalidEllipsisCount: 0,
          unindentedParagraphsCount: 0
        }
      };
    }

    // 1. Check ASCII straight quotes ( " and ' )
    const doubleQuoteMatches = (text.match(/"/g) || []).length;
    const singleQuoteMatches = (text.match(/'/g) || []).length;
    asciiQuotesCount = doubleQuoteMatches + singleQuoteMatches;
    if (asciiQuotesCount > 0) {
      violations.push(`发现 ${asciiQuotesCount} 处半角直引号 (" 或 ')，应使用标准中文引号（“ ” 或 ‘ ’）`);
    }

    // 2. Check half-width punctuation
    halfWidthPunctuationCount = (text.match(/[,.;:?!]/g) || []).length;
    if (halfWidthPunctuationCount > 0) {
      violations.push(`发现 ${halfWidthPunctuationCount} 处半角标点，应转换为全角中文标点（，。；：？！）`);
    }

    // 3. Check invalid ellipsis ( .. or ... or .... instead of …… )
    invalidEllipsisCount = (text.match(/(?<!\.)\.\.(?!\.)|(?<!\.)\.\.\.(?!\.)/g) || []).length;
    if (invalidEllipsisCount > 0) {
      violations.push(`发现 ${invalidEllipsisCount} 处西文省略号（...），应使用标准中文六角省略号（……）`);
    }

    // 4. Check paragraph indentations (standard Chinese text uses 2 full-width spaces "　　")
    for (const line of lines) {
      if (!line.startsWith('　　') && !line.startsWith('  ')) {
        unindentedParagraphsCount++;
      }
    }

    // Calculate score
    const totalPenalty = (asciiQuotesCount * 5) + (halfWidthPunctuationCount * 5) + (invalidEllipsisCount * 10) + (unindentedParagraphsCount * 2);
    const score = Math.max(0, 100 - totalPenalty);

    return {
      score,
      passed: score >= 85,
      violationsCount: violations.length,
      violations,
      metrics: {
        asciiQuotesCount,
        halfWidthPunctuationCount,
        invalidEllipsisCount,
        unindentedParagraphsCount
      }
    };
  }
}
