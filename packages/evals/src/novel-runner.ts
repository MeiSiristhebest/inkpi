import type { StateLedger } from '@meisiristhebest/protocol';
import { EntityConsistencyScorer, type ConsistencyScoreResult } from './benchmarks/entity-consistency.js';
import { ForeshadowingPayoffScorer, type ForeshadowingScoreResult } from './benchmarks/foreshadowing-payoff.js';
import { TypographyComplianceScorer, type TypographyComplianceResult } from './benchmarks/typography-compliance.js';

export interface NovelEvaluationInput {
  title?: string;
  documentTitle?: string;
  chapterTitle?: string;
  sectionTitle?: string;
  content: string;
  stateLedger?: StateLedger;
  targetSize?: number;
  targetWords?: number;
  expectedInvariants?: any[];
  customResolver?: (clue: string, text: string) => boolean;
}

export interface BenchmarkReport {
  title: string;
  chapterTitle: string;
  overallScore: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'F';
  passed: boolean;
  timestamp: number;
  scores: {
    characterConsistency: ConsistencyScoreResult;
    foreshadowingPayoff: ForeshadowingScoreResult;
    typographyCompliance: TypographyComplianceResult;
    contentSizeAdherence: {
      score: number;
      actualWords: number;
      targetSize: number;
      difference: number;
    };
    wordCountAdherence: {
      score: number;
      actualWords: number;
      targetWords: number;
      difference: number;
    };
  };
  summary: string;
}

export type NovelBenchmarkReport = BenchmarkReport;

/**
 * Explicit legacy/domain adapter for the narrative evaluation suite.
 * The generic EvalRunner does not construct or invoke this class implicitly.
 */
export class NovelEvalRunner {
  private consistencyScorer = new EntityConsistencyScorer();
  private foreshadowingScorer = new ForeshadowingPayoffScorer();
  private typographyScorer = new TypographyComplianceScorer();

  public evaluateDocument(input: NovelEvaluationInput): BenchmarkReport {
    const ledger = input.stateLedger || {
      entities: [],
      assets: [],
      tracks: [],
      locations: [],
      modifiedResources: []
    };
    const consistencyRes = this.consistencyScorer.score(input.content, ledger, input.expectedInvariants);
    const foreshadowingRes = this.foreshadowingScorer.score(ledger, input.content, input.customResolver);
    const typographyRes = this.typographyScorer.score(input.content);

    const chineseChars = (input.content.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (input.content.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[a-zA-Z0-9_-]+/g) || []).length;
    const actualWords = chineseChars + englishWords;
    const targetSize = (input.targetSize ?? input.targetWords ?? actualWords) || 1;
    const diff = Math.abs(actualWords - targetSize);
    const wordRatio = targetSize > 0 ? diff / targetSize : 0;
    const contentSizeScore = Math.max(0, Math.round(100 - wordRatio * 100));

    const overallScore = Math.round(
      consistencyRes.score * 0.35 +
      foreshadowingRes.score * 0.25 +
      typographyRes.score * 0.25 +
      contentSizeScore * 0.15
    );

    const grade = overallScore >= 95 ? 'S' : overallScore >= 85 ? 'A' : overallScore >= 75 ? 'B' : overallScore >= 60 ? 'C' : 'F';
    const passed = overallScore >= 75 && consistencyRes.passed;
    const sectionTitle = input.documentTitle || input.chapterTitle || input.sectionTitle || 'Content';

    return {
      title: input.title || '',
      chapterTitle: sectionTitle,
      overallScore,
      grade,
      passed,
      timestamp: Date.now(),
      scores: {
        characterConsistency: consistencyRes,
        foreshadowingPayoff: foreshadowingRes,
        typographyCompliance: typographyRes,
        contentSizeAdherence: {
          score: contentSizeScore,
          actualWords,
          targetSize,
          difference: diff
        },
        wordCountAdherence: {
          score: contentSizeScore,
          actualWords,
          targetWords: targetSize,
          difference: diff
        }
      },
      summary: `[${sectionTitle}] Evaluation Score: ${overallScore}/100 (Grade: ${grade}) - Entity Consistency: ${consistencyRes.score}, Condition Payoff: ${foreshadowingRes.score}, Typography: ${typographyRes.score}, Target Length: ${contentSizeScore}`
    };
  }

  public evaluateChapter(input: NovelEvaluationInput): BenchmarkReport {
    return this.evaluateDocument(input);
  }
}
