import type { AgentEvent } from '@inkpi/protocol';
import type { AgentOptions, AgentState } from '../types.js';
import type { ToolRegistry } from '../tools.js';
import type { MessageQueue } from '../queues.js';
import type { Clock } from '../ports/index.js';

/**
 * 一轮 agent 循环所需的共享依赖。
 *
 * 四个管线阶段（上下文变换 → 流式调用 → 工具派发 → 轮次收尾）只通过
 * 本对象通信，不再各自持有散落的形参。
 */
export interface TurnContext {
  state: AgentState;
  options: AgentOptions;
  toolRegistry: ToolRegistry;
  steeringQueue: MessageQueue;
  followUpQueue: MessageQueue;
  emitEvent: (event: AgentEvent) => Promise<void>;
  signal?: AbortSignal;
  /** 时间戳与 id 生成用的时钟，必填（由 `runAgentLoop` 提供默认值）。 */
  clock: Clock;
}

/** 把 `runAgentLoop` 的形参收敛为 `TurnContext`。 */
export interface TurnContextParams {
  state: AgentState;
  options: AgentOptions;
  toolRegistry: ToolRegistry;
  steeringQueue: MessageQueue;
  followUpQueue: MessageQueue;
  emitEvent: (event: AgentEvent) => Promise<void>;
  signal?: AbortSignal;
  clock?: Clock;
}
