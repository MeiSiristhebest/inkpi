import type { ModelConfig } from '@inkpi/ai';
import type { AgentRoleConfig, RuntimeState, Usage } from '@inkpi/protocol';
import type { Clock, ModelStreamer } from '../ports/index.js';
import { REAL_CLOCK } from '../ports/index.js';
import { emptyRuntimeState } from './ledger-merge.js';

export interface RoleInvocation {
  text: string;
  usage?: Usage;
}

/** 角色产出为空时抛出的错误，便于调用方区分"模型失败"与"模型无输出"。 */
export class RoleInvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoleInvocationError';
  }
}

/**
 * 把调用方提供的运行状态快照拼接进角色系统提示词。纯函数。
 *
 * 状态块为空时原样返回系统提示词，不追加空标题。
 */
export function assembleSystemPrompt(systemPrompt: string, stateBlock: string): string {
  return stateBlock ? `${systemPrompt}\n\n【Runtime State】\n${stateBlock}` : systemPrompt;
}

/** 由角色默认思考档位推导 token 预算。纯函数。 */
export function thinkingBudgetFor(level: AgentRoleConfig['defaultThinkingLevel']): number {
  return level === 'high' ? 4000 : 2000;
}

/**
 * 角色调用器：把"提示词装配 → 模型流式调用 → 结果收敛与空值校验"封装为一处。
 *
 * 与工作流其余部分只通过 `AgentRoleConfig` / `ModelConfig` 通信，
 * 便于在测试中整体替换。
 */
export class RoleInvoker {
  private clock: Clock;
  private streamFn?: ModelStreamer;

  constructor(clock: Clock = REAL_CLOCK, streamFn?: ModelStreamer) {
    this.clock = clock;
    this.streamFn = streamFn;
  }

  /**
   * 调用一个角色并返回其文本产出。
   *
   * @throws {RoleInvocationError} 未配置模型、模型返回错误、或产出为空。
   */
  public async invoke(args: {
    config: AgentRoleConfig;
    prompt: string;
    state?: RuntimeState;
    model?: ModelConfig;
    signal?: AbortSignal;
    stateFormatter?: (state: RuntimeState) => string;
    streamFn?: ModelStreamer;
    /** @deprecated Use state. */
    ledger?: RuntimeState;
    /** @deprecated Use stateFormatter. */
    ledgerFormatter?: (state: RuntimeState) => string;
  }): Promise<RoleInvocation> {
    const { config, prompt, model, signal } = args;

    if (!model) {
      throw new RoleInvocationError('Workflow requires an explicit model or executor.');
    }

    const state = args.state ?? args.ledger;
    const formatter = args.stateFormatter ?? args.ledgerFormatter;
    const stateBlock = formatter?.(state || emptyRuntimeState()) || '';
    const systemPrompt = assembleSystemPrompt(config.systemPrompt, stateBlock);

    let streamer = args.streamFn || this.streamFn;
    if (!streamer) {
      const aiMod = await import('@inkpi/ai');
      streamer = aiMod.streamAi;
    }

    const stream = streamer(model, [{ role: 'user', content: prompt, timestamp: this.clock() }], {
      systemPrompt,
      thinkingBudget: thinkingBudgetFor(config.defaultThinkingLevel),
      signal
    });

    const assistantMsg = await stream.collect();
    if (assistantMsg.stopReason === 'error') {
      throw new RoleInvocationError(
        assistantMsg.errorMessage || `Model failed during workflow stage '${config.role}'.`
      );
    }

    const text = assistantMsg.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as any).text)
      .join('\n');

    if (!text) {
      throw new RoleInvocationError(`Model returned empty output for workflow role '${config.role}'.`);
    }

    return { text, usage: assistantMsg.usage };
  }
}
