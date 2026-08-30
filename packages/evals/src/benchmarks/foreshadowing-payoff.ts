import type { StateLedger } from '@inkpi/protocol';

export interface ForeshadowingScoreResult {
  score: number; // 0 - 100
  passed: boolean;
  totalClues: number;
  resolvedClues: number;
  pendingClues: number;
  payoffRatePercent: number;
  unresolvedDetails: string[];
}

/**
 * 伏笔线索追踪与闭环率评分器 (Foreshadowing Payoff Scorer)
 * 量化长篇多轮会话中各支线悬念与线索的状态推进闭环率。
 */
export class ForeshadowingPayoffScorer {
  public score(
    ledger: StateLedger,
    currentText = '',
    customResolver?: (clue: string, text: string) => boolean
  ): ForeshadowingScoreResult {
    const clues = ledger.tracks || [];
    if (clues.length === 0) {
      return {
        score: 100,
        passed: true,
        totalClues: 0,
        resolvedClues: 0,
        pendingClues: 0,
        payoffRatePercent: 100,
        unresolvedDetails: []
      };
    }

    let resolvedCount = 0;
    const unresolved: string[] = [];

    for (const clue of clues) {
      const isResolvedInLedger = clue.status === 'resolved';
      const isResolvedByCustom = Boolean(customResolver && customResolver(clue.clue, currentText));
      
      // Removed hardcoded Chinese resolution checks
      if (isResolvedInLedger || isResolvedByCustom) {
        resolvedCount++;
      } else {
        unresolved.push(clue.clue);
      }
    }

    const pendingCount = clues.length - resolvedCount;
    const payoffRatePercent = Math.round((resolvedCount / clues.length) * 100);

    let score = 100;
    if (clues.length >= 5 && payoffRatePercent < 20) {
      score = Math.max(50, payoffRatePercent + 40);
    }

    return {
      score,
      passed: score >= 60,
      totalClues: clues.length,
      resolvedClues: resolvedCount,
      pendingClues: pendingCount,
      payoffRatePercent,
      unresolvedDetails: unresolved
    };
  }
}
