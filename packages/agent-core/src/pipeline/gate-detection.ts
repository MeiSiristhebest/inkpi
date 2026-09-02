import type { QualityGateIssue, QualityGateRule, StateLedger } from '@inkpi/protocol';
import { emptyLedger } from './ledger-merge.js';

/**
 * 纯函数：按一组门禁规则检测内容，返回命中的质量问题列表。无副作用、无 I/O。
 *
 * 原 `WorkflowCoordinator.detectPlotGateIssues`（公开）与 `detectIssues`（私有）含两份几乎一致的实现，
 * 现收敛为单一纯函数，二者均委托于此。行为逐字保持：
 * - `rule.pattern` 以 `RegExp` 或字符串构造，每次检测前 `lastIndex = 0`（避免全局正则状态串扰）；
 * - `rule.detector` 返回 falsy 视为未命中；
 * - `ledger` 缺省时回退到空账本。
 */
export function detectGateIssues(
  content: string,
  rules: QualityGateRule[],
  ledger?: StateLedger,
  context?: any
): QualityGateIssue[] {
  const safeLedger: StateLedger = ledger || emptyLedger();
  const issues: QualityGateIssue[] = [];

  for (const rule of rules) {
    if (rule.pattern) {
      const regex = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'g') : rule.pattern;
      regex.lastIndex = 0;
      if (regex.test(content)) {
        issues.push({
          type: rule.type,
          description: rule.description,
          severity: rule.severity
        });
      }
    }
    if (rule.detector) {
      const issue = rule.detector(content, safeLedger, context);
      if (issue) issues.push(issue);
    }
  }

  return issues;
}
