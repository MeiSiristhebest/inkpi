import type { AssistantMessage, AssistantMessageEvent, ContentBlock, ToolCallContent } from '@inkpi/protocol';

/**
 * 助手流式紧凑持久化帧（对齐上游 pi v0.85.x assistant-durability 与
 * `AssistantMessageFrameEncoder` 的设计，按 @inkpi/protocol 的事件词表再实现）。
 *
 * 设计合约（与上游保持一致的不变量）：
 * 1. 帧是**辅助观察数据**：缺失合法；不证明请求成功/失败；不选择重启点；基础恢复不依赖它；
 * 2. 每个非终态事件产出 0~1 帧；终态 `usage` / `error` 不产帧（终态由 settlement 持久化）；
 * 3. 块起始（text/thinking/toolCall）携带权威快照，其后只追加增量 delta，
 *    避免每个事件克隆全量消息造成写放大；
 * 4. `tool_call_end` 帧携带权威完整 ToolCallContent，其后该块的迟到 delta 一律丢弃；
 * 5. 帧只追加不重写；归约（{@linkcode reduceAssistantFrames}）按序重放即可重建部分消息。
 */
export type AssistantStreamFrame =
  | { type: 'text_start'; index: number; text: string }
  | { type: 'text_delta'; index: number; delta: string }
  | { type: 'thinking_start'; index: number; thinking: string }
  | { type: 'thinking_delta'; index: number; delta: string }
  | { type: 'tool_call_start'; index: number; toolCallId: string; toolName: string }
  | { type: 'tool_call_args'; index: number; toolCallId: string; delta: string }
  | { type: 'tool_call_end'; index: number; toolCall: ToolCallContent };

/**
 * 流式帧编码器：一个 provider 流对应一个实例，按序喂入每个事件。
 *
 * 与 `StreamInvoker` 的合并策略一致：全部 text 增量合并进同一个 text 块，
 * 全部 thinking 增量合并进同一个 thinking 块，toolCall 每次调用独占一个块。
 * 编码器维护自己的块下标与覆盖长度，与活跃流式消息解耦。
 */
export class AssistantFrameEncoder {
  private nextIndex = 0;
  private textIndex: number | undefined;
  private thinkingIndex: number | undefined;
  private toolCallState = new Map<string, { index: number; open: boolean; argsLength: number }>();

  /** 编码一个流事件；返回 0 或 1 帧（终态事件返回 null）。 */
  public encode(event: AssistantMessageEvent): AssistantStreamFrame | null {
    switch (event.type) {
      case 'text_delta': {
        if (this.textIndex === undefined) {
          this.textIndex = this.nextIndex++;
          return { type: 'text_start', index: this.textIndex, text: '' };
        }
        return { type: 'text_delta', index: this.textIndex, delta: event.textDelta };
      }
      case 'thinking_delta': {
        if (this.thinkingIndex === undefined) {
          this.thinkingIndex = this.nextIndex++;
          return { type: 'thinking_start', index: this.thinkingIndex, thinking: '' };
        }
        return { type: 'thinking_delta', index: this.thinkingIndex, delta: event.thinkingDelta };
      }
      case 'tool_call_start': {
        if (this.toolCallState.has(event.toolCallId)) return null;
        const index = this.nextIndex++;
        this.toolCallState.set(event.toolCallId, { index, open: true, argsLength: 0 });
        return { type: 'tool_call_start', index, toolCallId: event.toolCallId, toolName: event.toolName };
      }
      case 'tool_call_delta': {
        const state = this.toolCallState.get(event.toolCallId);
        // 已结算的调用拒收迟到增量（fencing）；未 start 的增量无归属块，同样丢弃。
        if (!state || !state.open) return null;
        state.argsLength += event.argsDelta.length;
        return { type: 'tool_call_args', index: state.index, toolCallId: event.toolCallId, delta: event.argsDelta };
      }
      case 'tool_call_end': {
        const state = this.toolCallState.get(event.toolCall.id);
        if (!state || !state.open) return null;
        state.open = false;
        return { type: 'tool_call_end', index: state.index, toolCall: event.toolCall };
      }
      case 'usage':
      case 'error':
        // 终态：不产帧。终态结果由 operation_settlement / agent_turn 结算条目持久化。
        return null;
      default:
        return null;
    }
  }
}

/**
 * 按序重放帧序列，重建崩溃时的部分助手消息。
 *
 * - 空帧序列返回 null（"缺失合法"，调用方不应据此断言任何失败）；
 * - `tool_call_args` 先在内部累积原始 JSON 前缀，`tool_call_end` 到达时以权威
 *   ToolCallContent 覆盖整块（参数已解析则使用解析值，否则保留空对象）；
 * - 重建的消息 `stopReason` 恒为 `'aborted'`：它只是进行中快照，不是模型终态。
 */
export function reduceAssistantFrames(frames: readonly AssistantStreamFrame[]): AssistantMessage | null {
  if (!frames || frames.length === 0) return null;

  const content: ContentBlock[] = [];
  const rawArgsByIndex = new Map<number, string>();

  const ensureTextBlock = (index: number): Extract<ContentBlock, { type: 'text' }> => {
    let block = content[index] as Extract<ContentBlock, { type: 'text' }> | undefined;
    if (!block || block.type !== 'text') {
      block = { type: 'text', text: '' };
      content[index] = block;
    }
    return block;
  };
  const ensureThinkingBlock = (index: number): Extract<ContentBlock, { type: 'thinking' }> => {
    let block = content[index] as Extract<ContentBlock, { type: 'thinking' }> | undefined;
    if (!block || block.type !== 'thinking') {
      block = { type: 'thinking', thinking: '' };
      content[index] = block;
    }
    return block;
  };
  const ensureToolCallBlock = (
    index: number,
    toolCallId: string,
    toolName: string
  ): Extract<ContentBlock, { type: 'toolCall' }> => {
    let block = content[index] as Extract<ContentBlock, { type: 'toolCall' }> | undefined;
    if (!block || block.type !== 'toolCall') {
      block = { type: 'toolCall', id: toolCallId, name: toolName, arguments: {} };
      content[index] = block;
    }
    return block;
  };

  for (const frame of frames) {
    if (!frame || typeof frame !== 'object' || typeof (frame as any).type !== 'string') continue;
    switch (frame.type) {
      case 'text_start':
        ensureTextBlock(frame.index).text = frame.text;
        break;
      case 'text_delta':
        ensureTextBlock(frame.index).text += frame.delta;
        break;
      case 'thinking_start':
        ensureThinkingBlock(frame.index).thinking = frame.thinking;
        break;
      case 'thinking_delta':
        ensureThinkingBlock(frame.index).thinking += frame.delta;
        break;
      case 'tool_call_start':
        ensureToolCallBlock(frame.index, frame.toolCallId, frame.toolName);
        break;
      case 'tool_call_args': {
        ensureToolCallBlock(frame.index, frame.toolCallId, 'unknown_tool');
        rawArgsByIndex.set(frame.index, (rawArgsByIndex.get(frame.index) ?? '') + frame.delta);
        break;
      }
      case 'tool_call_end': {
        // tool_call_end 帧携带权威块值；未 start 过的块直接忽略（帧流自洽性由编码器保证）。
        const existing = content[frame.index];
        if (!existing || existing.type !== 'toolCall') break;
        content[frame.index] = { ...frame.toolCall };
        rawArgsByIndex.delete(frame.index);
        break;
      }
      default:
        break;
    }
  }

  // 未见 tool_call_end 的未完结调用：尽力解析已累积的 JSON 前缀，失败则保留空参数。
  for (const [index, raw] of rawArgsByIndex) {
    const block = content[index];
    if (block && block.type === 'toolCall') {
      try {
        block.arguments = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        block.arguments = {};
      }
    }
  }

  return {
    role: 'assistant',
    content: content.filter((block): block is ContentBlock => Boolean(block)),
    stopReason: 'aborted',
    errorMessage: 'Partially recovered from persisted stream frames (no terminal settlement).'
  };
}
