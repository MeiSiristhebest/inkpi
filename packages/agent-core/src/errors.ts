/**
 * agent-core 领域错误类型。
 */

/** 创建会话时既未提供显式模型、也无默认模型配置时抛出，取代原先静默回落到假模型的行为。 */
export class NoModelConfiguredError extends Error {
  constructor(
    message = 'No model configured. Pass an explicit model to the session, set a default model on the session manager, or configure a provider.'
  ) {
    super(message);
    this.name = 'NoModelConfiguredError';
  }
}

/** 骰子记号（如 "1d20"）非法时抛出，取代原先返回伪造随机结果的行为。 */
export class InvalidDiceNotationError extends Error {
  constructor(notation: string, message?: string) {
    super(message ?? `Invalid dice notation: '${notation}'. Expected format like '1d20' or '3d6+2'.`);
    this.name = 'InvalidDiceNotationError';
  }
}
