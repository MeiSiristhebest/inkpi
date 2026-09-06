import type { AgentMessage } from '@inkpi/protocol';
import type { ModelConfig } from './types.js';

/**
 * 跨模型历史上下文消毒：
 * 1. 规范化 Tool Call ID（限制在 64 字符内且移除非法字符，防止从 OpenAI/Responses 切到 Claude/Anthropic 时抛格式错误）
 * 2. 清理空内容块，确保向下游 Provider 发送合规的消息数组
 */
export function sanitizeMessagesForProvider(messages: AgentMessage[], _targetModel?: ModelConfig): AgentMessage[] {
  return messages.map((msg) => {
    if (msg.role === 'assistant') {
      const sanitizedContent = msg.content.map((item) => {
        if (item.type === 'toolCall') {
          // 清洗可能引起非标端点或 Anthropic 报错的异常 ID 字符（如管道符 | 或超长 ID）
          const safeId = item.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
          return { ...item, id: safeId };
        }
        return item;
      });
      return { ...msg, content: sanitizedContent };
    }
    if (msg.role === 'toolResult') {
      const safeId = msg.toolCallId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
      return { ...msg, toolCallId: safeId };
    }
    return msg;
  });
}
