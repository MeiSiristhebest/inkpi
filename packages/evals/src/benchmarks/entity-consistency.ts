import type { StateLedger } from '@inkpi/protocol';

export interface ConsistencyScoreResult {
  score: number; // 0 - 100
  passed: boolean;
  violations: string[];
  trackedCharactersCount: number;
}

export interface InvariantRule {
  character: string;
  condition?: (text: string, status?: string) => boolean;
  forbiddenTransitions?: string[];
  requiredKeywords?: string[];
}

/**
 * 实体状态与上下文一致性基准评分器
 * 检查模型生成文本与会话状态账本之间是否违背不变式约束。
 */
export class EntityConsistencyScorer {
  /**
   * Score the consistency between the text and the state ledger based on generic rules
   */
  public score(text: string, ledger: StateLedger, expectedInvariants?: InvariantRule[]): ConsistencyScoreResult {
    const violations: string[] = [];
    let trackedCount = 0;

    const entities = ledger.entities || (ledger as any).characters || [];
    if (entities.length === 0) {
      return { score: 100, passed: true, violations: [], trackedCharactersCount: 0 };
    }

    const charMap = new Map<string, any>();
    for (const char of entities) {
      charMap.set(char.name, char);
      if (text.includes(char.name)) {
        trackedCount++;
      }
      if (char.status && (char.status.includes('Injured') || char.status.includes('重伤'))) {
        if (text.includes(char.name) && /(?:without errors|无伤|完好无损|生龙活虎|奔跑|纵身跃起)/i.test(text)) {
          violations.push(`Entity [${char.name}] status is ${char.status} but text implies healthy state.`);
        }
      }
    }

    if (expectedInvariants) {
      for (const inv of expectedInvariants) {
        const char = charMap.get(inv.character);
        if (inv.forbiddenTransitions) {
          for (const forbidden of inv.forbiddenTransitions) {
            if (text.includes(forbidden)) {
              violations.push(`Entity [${inv.character}] forbidden transition triggered: "${forbidden}"`);
            }
          }
        }
        if (inv.condition && !inv.condition(text, char?.status)) {
          violations.push(`Entity [${inv.character}] failed conditional invariant constraint`);
        }
        if (inv.requiredKeywords) {
          for (const kw of inv.requiredKeywords) {
            if (!text.includes(kw)) {
              violations.push(`Entity [${inv.character}] missing required keyword: "${kw}"`);
            }
          }
        }
      }
    }

    const deduction = violations.length * 25;
    const score = Math.max(0, 100 - deduction);

    return {
      score,
      passed: score >= 80,
      violations,
      trackedCharactersCount: trackedCount
    };
  }
}

export const CharacterConsistencyScorer = EntityConsistencyScorer;
export type CharacterConsistencyScorer = EntityConsistencyScorer;
