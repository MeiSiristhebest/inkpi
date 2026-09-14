import type { QualityGateIssue, QualityGateRule } from '@inkpi/protocol';

/**
 * 纯函数：按一组门禁规则检测内容，返回命中的质量问题列表。无副作用、无 I/O。
 *
 * WorkflowCoordinator 只通过通用质量门禁方法委托到此函数。行为保持：
 * - `rule.pattern` 以 `RegExp` 或字符串构造，每次检测前 `lastIndex = 0`（避免全局正则状态串扰）；
 * - `rule.detector` 返回 falsy 视为未命中；
 * - caller context is passed through unchanged;
 * - no product-domain state is created when context is omitted.
 */
export function detectGateIssues(
  content: string,
  rules: QualityGateRule[],
  context?: unknown,
  metadata?: unknown
): QualityGateIssue[] {
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
      const issue = rule.detector(content, context, metadata);
      if (issue) issues.push(issue);
    }
  }

  return issues;
}
