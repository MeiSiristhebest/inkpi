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
 * 中文出版级排版规范评分器 (Chinese Typography Compliance Scorer)
 * 检测半角引号、半角逗号句号、非标准省略号以及段落缩进违规。
 */
export class TypographyComplianceScorer {
  public score(text: string): TypographyComplianceResult {
    const violations: string[] = [];
    const lines = text.split('\n').filter((l) => l.trim().length > 0);

    // 1. Check ASCII straight quotes ( " and ' )
    const doubleQuoteMatches = (text.match(/"/g) || []).length;
    const singleQuoteMatches = (text.match(/'/g) || []).length;
    const asciiQuotesCount = doubleQuoteMatches + singleQuoteMatches;
    if (asciiQuotesCount > 0) {
      violations.push(`发现 ${asciiQuotesCount} 处半角直引号 (" 或 ')，应使用标准中文引号（“ ” 或 ‘ ’）`);
    }

    // 2. Check half-width punctuation
    const halfWidthPunctuationCount = (text.match(/[,.;:?!]/g) || []).length;
    if (halfWidthPunctuationCount > 0) {
      violations.push(`发现 ${halfWidthPunctuationCount} 处半角标点，应转换为全角中文标点（，。；：？！）`);
    }

    // 3. Check invalid ellipsis ( .. or ... or .... instead of …… )
    const invalidEllipsisCount = (text.match(/(?<!\.)\.\.(?!\.)|(?<!\.)\.\.\.(?!\.)/g) || []).length;
    if (invalidEllipsisCount > 0) {
      violations.push(`发现 ${invalidEllipsisCount} 处西文省略号（...），应使用标准中文六角省略号（……）`);
    }

    // 4. Check paragraph indentations (standard Chinese text uses 2 full-width spaces "　　")
    let unindentedParagraphsCount = 0;
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
