/**
 * AI 包领域错误类型。
 * 这些错误用于在不支持的功能被使用时给出明确的失败信号，
 * 取代原先「静默映射 / 静默回落到假实现」的行为。
 */

/**
 * 当请求了一个尚未实现的 Provider 时抛出。
 * 例如 `azure` / `bedrock` 在当前构建中未提供真实传输层。
 */
export class ProviderNotImplementedError extends Error {
  public readonly provider: string;

  constructor(provider: string, message?: string) {
    super(message ?? `Provider '${provider}' is not implemented in this build. Configure a supported provider or implement a transport.`);
    this.name = 'ProviderNotImplementedError';
    this.provider = provider;
  }
}
