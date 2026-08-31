import type { Usage, UsageTotals } from '@inkpi/protocol';
import { findModelInCatalog } from './catalog.js';

export interface UsageCostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  totalCost: number;
  savedCostByCache: number;
  cacheHitRatio: number;
}

export function calculateCost(
  costConfig: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    cacheReadPerMillionUsd?: number;
    cacheWritePerMillionUsd?: number;
  },
  usage: Usage
): number {
  const input = usage.inputTokens || 0;
  const output = usage.outputTokens || 0;
  const cacheRead = usage.cacheReadTokens || 0;
  const cacheWrite = usage.cacheWriteTokens || 0;

  const inputCost = (input / 1_000_000) * costConfig.inputPerMillionUsd;
  const outputCost = (output / 1_000_000) * costConfig.outputPerMillionUsd;
  const cacheReadCost = (cacheRead / 1_000_000) * (costConfig.cacheReadPerMillionUsd || 0);
  const cacheWriteCost = (cacheWrite / 1_000_000) * (costConfig.cacheWritePerMillionUsd || 0);

  return inputCost + outputCost + cacheReadCost + cacheWriteCost;
}


export class UsageTracker {
  private totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0
  };

  /**
   * 记录一次模型调用的 Token 用量并自动折算美元/人民币成本 (1:1 对标 repos/pi UsageTotals)
   */
  public recordUsage(usage: Usage, modelIdOrName?: string): void {
    const input = usage.inputTokens || 0;
    const output = usage.outputTokens || 0;
    const cacheRead = usage.cacheReadTokens || 0;
    const cacheWrite = usage.cacheWriteTokens || 0;
    const total = usage.totalTokens || input + output;

    this.totals.inputTokens += input;
    this.totals.outputTokens += output;
    this.totals.cacheReadTokens += cacheRead;
    this.totals.cacheWriteTokens += cacheWrite;
    this.totals.totalTokens += total;

    if (modelIdOrName) {
      const entry = findModelInCatalog(modelIdOrName);
      if (entry) {
        const inputCost = (input / 1_000_000) * entry.cost.inputPerMillionUsd;
        const outputCost = (output / 1_000_000) * entry.cost.outputPerMillionUsd;
        const cacheReadCost = ((cacheRead / 1_000_000) * (entry.cost.cacheReadPerMillionUsd || 0));
        const cacheWriteCost = ((cacheWrite / 1_000_000) * (entry.cost.cacheWritePerMillionUsd || 0));
        this.totals.costUsd += inputCost + outputCost + cacheReadCost + cacheWriteCost;
      }
    }
  }

  public getCostBreakdown(modelIdOrName: string): UsageCostBreakdown {
    const entry = findModelInCatalog(modelIdOrName);
    const inputCost = entry ? (this.totals.inputTokens / 1_000_000) * entry.cost.inputPerMillionUsd : 0;
    const outputCost = entry ? (this.totals.outputTokens / 1_000_000) * entry.cost.outputPerMillionUsd : 0;
    const cacheReadCost = entry ? ((this.totals.cacheReadTokens / 1_000_000) * (entry.cost.cacheReadPerMillionUsd || 0)) : 0;
    const cacheWriteCost = entry ? ((this.totals.cacheWriteTokens / 1_000_000) * (entry.cost.cacheWritePerMillionUsd || 0)) : 0;
    
    // Normal cost without cache
    const nonCachedInputCost = entry ? ((this.totals.inputTokens + this.totals.cacheReadTokens) / 1_000_000) * entry.cost.inputPerMillionUsd : 0;
    const savedCost = Math.max(0, nonCachedInputCost - (inputCost + cacheReadCost));
    const totalPromptTokens = this.totals.inputTokens + this.totals.cacheReadTokens;
    const cacheHitRatio = totalPromptTokens > 0 ? this.totals.cacheReadTokens / totalPromptTokens : 0;

    return {
      inputCost,
      outputCost,
      cacheReadCost,
      cacheWriteCost,
      totalCost: inputCost + outputCost + cacheReadCost + cacheWriteCost,
      savedCostByCache: savedCost,
      cacheHitRatio
    };
  }

  public getTotals(): UsageTotals {
    return { ...this.totals };
  }

  public reset(): void {
    this.totals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 0,
      costUsd: 0
    };
  }
}

