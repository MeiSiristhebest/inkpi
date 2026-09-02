import type { QualityGateRule, WorkflowStageConfig } from '@inkpi/protocol';

/**
 * 质量门禁规则注册表：全局规则 + 阶段局部规则的合并视图。
 */
export class GateRuleRegistry {
  private rules: QualityGateRule[];

  constructor(initial: QualityGateRule[] = []) {
    this.rules = [...initial];
  }

  /** 追加一条全局规则。 */
  public add(rule: QualityGateRule): this {
    this.rules.push(rule);
    return this;
  }

  /** 返回某阶段生效的规则：全局规则在前，阶段局部规则在后。 */
  public forStage(stage: WorkflowStageConfig): QualityGateRule[] {
    return [...this.rules, ...(stage.gateRules || [])];
  }

  /** 返回全局规则的副本，用于脱离阶段上下文的独立检测。 */
  public all(): QualityGateRule[] {
    return [...this.rules];
  }

  /** 全局规则条数，供测试与诊断使用。 */
  public get size(): number {
    return this.rules.length;
  }
}
