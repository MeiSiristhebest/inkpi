import type { AgentMessage } from '@inkpi/protocol';
import { AgentLoopRunner } from './turn/index.js';
import type { RunLoopParams } from './turn/index.js';

export * from './turn/index.js';

/**
 * 运行 agent 主循环直到收敛。
 *
 * 实现已拆为四段管线（见 `src/turn/`），本函数保留为公开入口，
 * 行为与拆分前逐字一致。
 */
export async function runAgentLoop(params: RunLoopParams): Promise<AgentMessage[]> {
  return new AgentLoopRunner().run(params);
}
