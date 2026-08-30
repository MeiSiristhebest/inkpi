import type { StateLedger } from '@inkpi/protocol';
import { EntityConsistencyScorer, type ConsistencyScoreResult } from './benchmarks/entity-consistency.js';
import { ForeshadowingPayoffScorer, type ForeshadowingScoreResult } from './benchmarks/foreshadowing-payoff.js';
import { TypographyComplianceScorer, type TypographyComplianceResult } from './benchmarks/typography-compliance.js';

export interface EvaluationInput {
  title: string;
  chapterTitle?: string;
  documentTitle?: string;
  sectionTitle?: string;
  content: string;
  stateLedger: StateLedger;
  targetSize?: number;
  targetWords?: number;
  expectedInvariants?: any[];
  customResolver?: (clue: string, text: string) => boolean;
}

export type NovelEvaluationInput = EvaluationInput;

export interface BenchmarkReport {
  title: string;
  chapterTitle: string;
  overallScore: number; // 0 - 100
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
    wordCountAdherence?: {
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
 * 纯通用 AI 内容生成与一致性评测运行器 (1:1 对标 repos/pi packages/evals runner)
 * 对生成质量、实体状态一致性、约束闭环率与排版规范进行自动化 Benchmark 评分。
 */
export class EvalRunner {
  private consistencyScorer = new EntityConsistencyScorer();
  private foreshadowingScorer = new ForeshadowingPayoffScorer();
  private typographyScorer = new TypographyComplianceScorer();

  public evaluateDocument(input: EvaluationInput): BenchmarkReport {
    const consistencyRes = this.consistencyScorer.score(input.content, input.stateLedger as any, input.expectedInvariants);
    const foreshadowingRes = this.foreshadowingScorer.score(input.stateLedger as any, input.content, input.customResolver);
    const typographyRes = this.typographyScorer.score(input.content);

    // Calculate actual words (Chinese characters + English words)
    const chineseChars = (input.content.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (input.content.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[a-zA-Z0-9_-]+/g) || []).length;
    const actualWords = chineseChars + englishWords;
    const targetSize = input.targetSize || input.targetWords || actualWords || 1;

    const diff = Math.abs(actualWords - targetSize);
    const wordRatio = targetSize > 0 ? diff / targetSize : 0;
    const contentSizeScore = Math.max(0, Math.round(100 - wordRatio * 100));

    // Weighted overall score:
    // Character consistency: 35%
    // Foreshadowing: 25%
    // Typography: 25%
    // Word count: 15%
    const overallScore = Math.round(
      consistencyRes.score * 0.35 +
      foreshadowingRes.score * 0.25 +
      typographyRes.score * 0.25 +
      contentSizeScore * 0.15
    );

    let grade: 'S' | 'A' | 'B' | 'C' | 'F' = 'F';
    if (overallScore >= 95) grade = 'S';
    else if (overallScore >= 85) grade = 'A';
    else if (overallScore >= 75) grade = 'B';
    else if (overallScore >= 60) grade = 'C';

    const passed = overallScore >= 75 && consistencyRes.passed;
    const secTitle = input.documentTitle || input.chapterTitle || input.sectionTitle || 'Content';

    const summary = `[${secTitle}] Evaluation Score: ${overallScore}/100 (Grade: ${grade}) - Entity Consistency: ${consistencyRes.score}, Condition Payoff: ${foreshadowingRes.score}, Typography: ${typographyRes.score}, Target Length: ${contentSizeScore}`;

    return {
      title: input.title,
      chapterTitle: secTitle,
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
      summary
    };
  }

  public evaluateChapter(input: EvaluationInput): BenchmarkReport {
    return this.evaluateDocument(input);
  }
}

export const NovelEvalRunner = EvalRunner;
export type NovelEvalRunner = EvalRunner;
