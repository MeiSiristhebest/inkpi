import type { AssistantMessage, ToolCallContent } from '@inkpi/protocol';

/**
 * 从一条 assistant 消息中提取所有工具调用。纯函数，无副作用。
 *
 * 原内联于 `runAgentLoop` 的「遍历 content 取 toolCall」逻辑，抽出便于单测与复用。
 */
export function extractToolCalls(message: AssistantMessage): ToolCallContent[] {
  const toolCalls: ToolCallContent[] = [];
  for (const item of message.content) {
    if (item.type === 'toolCall') {
      toolCalls.push(item);
    }
  }
  return toolCalls;
}
