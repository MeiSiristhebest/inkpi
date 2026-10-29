import type { AgentMessage, ProviderModelSource } from '@inkpi/protocol';
import type { ModelConfig } from './types.js';

/**
 * 跨模型历史上下文消毒：
 * 1. 规范化 Tool Call ID（限制在 64 字符内且移除非法字符，防止从 OpenAI/Responses 切到 Claude/Anthropic 时抛格式错误）
 * 2. 仅在来源与目标 provider、模型及已知 route 完全匹配时保留签名 thinking 块
 */
export function sanitizeMessagesForProvider(messages: AgentMessage[], targetModel?: ModelConfig): AgentMessage[] {
  const targetSource = targetModel ? providerModelSource(targetModel) : undefined;
  return messages.map((msg) => {
    if (msg.role === 'assistant') {
      const sanitizedContent: typeof msg.content = [];
      for (const item of msg.content) {
        if (item.type === 'thinking') {
          if (hasCompatibleProviderSource(msg.providerSource, targetSource) && item.providerSignature) {
            sanitizedContent.push(item);
          }
          continue;
        }
        if (item.type === 'toolCall') {
          // 清洗可能引起非标端点或 Anthropic 报错的异常 ID 字符（如管道符 | 或超长 ID）
          const safeId = item.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
          sanitizedContent.push({ ...item, id: safeId });
          continue;
        }
        sanitizedContent.push(item);
      }
      return { ...msg, content: sanitizedContent };
    }
    if (msg.role === 'toolResult') {
      const safeId = msg.toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      return { ...msg, toolCallId: safeId };
    }
    return msg;
  });
}

function providerModelSource(model: ModelConfig): ProviderModelSource {
  const routeId = model.routeId?.trim();
  const source: ProviderModelSource = {
    provider: String(model.provider),
    modelId: model.id
  };
  if (routeId) {
    source.routeId = routeId;
  } else if (model.routeId !== undefined || model.baseUrl) {
    source.routeId = null;
  }
  return source;
}

function hasCompatibleProviderSource(
  source: ProviderModelSource | undefined,
  target: ProviderModelSource | undefined
): boolean {
  return (
    source !== undefined &&
    target !== undefined &&
    source.provider === target.provider &&
    source.modelId === target.modelId &&
    source.routeId !== null &&
    target.routeId !== null &&
    source.routeId === target.routeId
  );
}
