import type { AgentMessage } from '@inkpi/protocol';
import type { SessionCompactor } from './compaction.js';

export interface ContextBudgetPlanInput {
  contextWindowTokens?: number;
  outputReserveTokens?: number;
  estimatedInputTokens?: number;
  messages?: AgentMessage[];
}

export interface ContextBudgetPlan {
  contextWindowTokens?: number;
  outputReserveTokens: number;
  inputBudgetTokens?: number;
  estimatedInputTokens?: number;
  overBudget: boolean;
  firstCall: boolean;
}

/**
 * Centralizes provider-window arithmetic so first calls and tool-loop calls use
 * the same reserve and never silently exceed a route's declared context limit.
 */
export class ContextBudgetPlanner {
  private readonly defaultOutputReserveTokens: number;

  constructor(defaultOutputReserveTokens = 0) {
    this.defaultOutputReserveTokens = Math.max(0, Math.floor(defaultOutputReserveTokens));
  }

  plan(input: ContextBudgetPlanInput, compactor?: SessionCompactor): ContextBudgetPlan {
    const outputReserveTokens = positiveOr(input.outputReserveTokens, this.defaultOutputReserveTokens);
    const estimatedInputTokens =
      input.estimatedInputTokens ??
      (input.messages && compactor ? compactor.estimateTokens(input.messages) : undefined);
    const inputBudgetTokens =
      input.contextWindowTokens === undefined
        ? undefined
        : Math.max(0, Math.floor(input.contextWindowTokens - outputReserveTokens));
    return {
      contextWindowTokens: input.contextWindowTokens,
      outputReserveTokens,
      inputBudgetTokens,
      estimatedInputTokens,
      overBudget:
        inputBudgetTokens !== undefined && estimatedInputTokens !== undefined
          ? estimatedInputTokens > inputBudgetTokens
          : false,
      firstCall: (input.messages?.length ?? 0) <= 1
    };
  }

  shouldCompact(input: ContextBudgetPlanInput, compactor: SessionCompactor): boolean {
    const plan = this.plan(input, compactor);
    return plan.overBudget || compactor.shouldCompact(input.messages ?? []);
  }
}

function positiveOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
