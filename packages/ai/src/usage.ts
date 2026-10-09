import type { Usage, UsageTotals } from '@inkpi/protocol';
import { findModelInCatalog } from './catalog.js';
import type { ModelPriceDescriptor } from './catalog.js';
import { calculateDynamicModelCost, calculateModelCost } from './cost.js';

export interface UsageCostBreakdown {
  inputCost: number | null;
  outputCost: number | null;
  cacheReadCost: number | null;
  cacheWriteCost: number | null;
  totalCost: number | null;
  savedCostByCache: number | null;
  cacheHitRatio: number;
  status: 'known' | 'partial' | 'unknown';
}

interface MutableCostBreakdown {
  inputCost: number | null;
  outputCost: number | null;
  cacheReadCost: number | null;
  cacheWriteCost: number | null;
  savedCostByCache: number | null;
  cacheHitRatio: number;
  status: 'known' | 'partial' | 'unknown';
}

interface ModelUsageRecord {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: MutableCostBreakdown;
}

/** Calculate a request's cost or return null when a used price is unavailable. */
export function calculateCost(costConfig: ModelPriceDescriptor, usage: Usage): number | null {
  return calculateModelCost(costConfig, usage).totalCostUsd;
}

export class UsageTracker {
  private totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    costStatus: 'known'
  };
  private byModel = new Map<string, ModelUsageRecord>();

  /** Record one provider request and keep its pricing tied to that model. */
  public recordUsage(usage: Usage, modelIdOrName?: string): void {
    const input = usage.inputTokens || 0;
    const output = usage.outputTokens || 0;
    const cacheRead = usage.cacheReadTokens || 0;
    const cacheWrite = usage.cacheWriteTokens ?? (usage.cacheWrite5mTokens ?? 0) + (usage.cacheWrite1hTokens ?? 0);
    const total = usage.totalTokens || input + output;

    this.totals.inputTokens += input;
    this.totals.outputTokens += output;
    this.totals.cacheReadTokens += cacheRead;
    this.totals.cacheWriteTokens += cacheWrite;
    this.totals.totalTokens += total;

    if (!modelIdOrName) {
      this.totals.costStatus = combineCostStatus(this.totals.costStatus ?? 'known', 'unknown');
      return;
    }

    const model = findModelInCatalog(modelIdOrName);
    const calculation = calculateDynamicModelCost(modelIdOrName, usage, model?.cost);
    const knownCost = [
      calculation.inputCostUsd,
      calculation.outputCostUsd,
      calculation.cacheReadCostUsd,
      calculation.cacheWriteCostUsd
    ].reduce<number>((sum, cost) => sum + (cost ?? 0), 0);
    this.totals.costUsd += knownCost;
    this.totals.costStatus = combineCostStatus(this.totals.costStatus ?? 'known', calculation.status);

    const key = modelIdOrName.trim().toLowerCase();
    let record = this.byModel.get(key);
    if (!record) {
      record = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: emptyCostBreakdown()
      };
      this.byModel.set(key, record);
    }
    record.inputTokens += input;
    record.outputTokens += output;
    record.cacheReadTokens += cacheRead;
    record.cacheWriteTokens += cacheWrite;
    record.cost.inputCost = addCost(record.cost.inputCost, calculation.inputCostUsd);
    record.cost.outputCost = addCost(record.cost.outputCost, calculation.outputCostUsd);
    record.cost.cacheReadCost = addCost(record.cost.cacheReadCost, calculation.cacheReadCostUsd);
    record.cost.cacheWriteCost = addCost(record.cost.cacheWriteCost, calculation.cacheWriteCostUsd);
    record.cost.savedCostByCache = addCost(record.cost.savedCostByCache, calculation.savedCostByCacheUsd);
    record.cost.status = combineCostStatus(record.cost.status, calculation.status);
  }

  public getCostBreakdown(modelIdOrName: string): UsageCostBreakdown {
    const record = this.byModel.get(modelIdOrName.trim().toLowerCase());
    if (!record) {
      return {
        inputCost: 0,
        outputCost: 0,
        cacheReadCost: 0,
        cacheWriteCost: 0,
        totalCost: 0,
        savedCostByCache: 0,
        cacheHitRatio: 0,
        status: 'known'
      };
    }

    const cost = record.cost;
    const parts = [cost.inputCost, cost.outputCost, cost.cacheReadCost, cost.cacheWriteCost];
    const totalCost = parts.some((part) => part === null)
      ? null
      : parts.reduce<number>((sum, part) => sum + (part ?? 0), 0);
    const promptTokens = record.inputTokens + record.cacheReadTokens;
    return {
      ...cost,
      totalCost,
      cacheHitRatio: promptTokens > 0 ? record.cacheReadTokens / promptTokens : 0
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
      costUsd: 0,
      costStatus: 'known'
    };
    this.byModel.clear();
  }
}

function emptyCostBreakdown(): MutableCostBreakdown {
  return {
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    savedCostByCache: 0,
    cacheHitRatio: 0,
    status: 'known'
  };
}

function addCost(current: number | null, next: number | null): number | null {
  return current === null || next === null ? null : current + next;
}

function combineCostStatus(
  current: 'known' | 'partial' | 'unknown',
  next: 'known' | 'partial' | 'unknown'
): 'known' | 'partial' | 'unknown' {
  const rank = { known: 0, partial: 1, unknown: 2 } as const;
  return rank[current] >= rank[next] ? current : next;
}
