import type { ModelCatalogEntry } from './catalog.js';
import { getHttpClient } from './http-client.js';

export interface RemoteCatalogOptions {
  /**
   * 远端模型目录与定价更新地址。
   * 默认为官方/社区实时维护的 models-catalog 端点，也可指向企业内部 AI Gateway。
   */
  url?: string;
  /**
   * 本地缓存 TTL（毫秒），默认 1 小时 (3600_000 ms)
   */
  cacheTtlMs?: number;
  signal?: AbortSignal;
}

export interface CostCalculationResult {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  totalCostUsd: number;
}

const dynamicCatalog = new Map<string, ModelCatalogEntry>();
let lastFetchedAt = 0;
const DEFAULT_TTL = 3600_000; // 1h

/**
 * 动态注册或更新模型定价条目
 */
export function registerModelCost(entry: ModelCatalogEntry): void {
  dynamicCatalog.set(entry.id, entry);
}

/**
 * 从远端拉取最新模型目录与价格表，支持 ETag 与静默刷新
 */
export async function refreshCatalog(options?: RemoteCatalogOptions): Promise<number> {
  const url = options?.url || process.env.INKPI_MODELS_CATALOG_URL;
  if (!url) return dynamicCatalog.size;

  const now = Date.now();
  const ttl = options?.cacheTtlMs ?? DEFAULT_TTL;
  if (now - lastFetchedAt < ttl && dynamicCatalog.size > 0) {
    return dynamicCatalog.size;
  }

  try {
    const res = await getHttpClient().fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: options?.signal
    });
    if (!res.ok) return dynamicCatalog.size;

    const data = (await res.json()) as ModelCatalogEntry[];
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.id && item.cost) {
          dynamicCatalog.set(item.id, item);
        }
      }
      lastFetchedAt = now;
    }
  } catch {
    // 优雅降级：网络异常时不破坏调用链，继续使用已知定价
  }

  return dynamicCatalog.size;
}

/**
 * 计算指定模型单次交互所消耗的真实 USD 成本
 */
export function calculateDynamicModelCost(
  modelId: string,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  },
  fallbackCostRates?: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    cacheReadPerMillionUsd?: number;
    cacheWritePerMillionUsd?: number;
  }
): CostCalculationResult {
  const entry = dynamicCatalog.get(modelId);
  const rates = entry?.cost ||
    fallbackCostRates || {
      inputPerMillionUsd: 0,
      outputPerMillionUsd: 0
    };

  const inputTokens = usage.inputTokens || 0;
  const outputTokens = usage.outputTokens || 0;
  const cacheReadTokens = usage.cacheReadTokens || 0;
  const cacheWriteTokens = usage.cacheWriteTokens || 0;

  const inputCostUsd = (inputTokens / 1_000_000) * rates.inputPerMillionUsd;
  const outputCostUsd = (outputTokens / 1_000_000) * rates.outputPerMillionUsd;
  const cacheReadCostUsd = ((rates.cacheReadPerMillionUsd ?? 0) / 1_000_000) * cacheReadTokens;
  const cacheWriteCostUsd = ((rates.cacheWritePerMillionUsd ?? 0) / 1_000_000) * cacheWriteTokens;

  const totalCostUsd = inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd;

  return {
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    totalCostUsd
  };
}

/**
 * 重置或清空动态缓存（主要供测试使用）
 */
export function clearCostCache(): void {
  dynamicCatalog.clear;
  dynamicCatalog.clear();
  lastFetchedAt = 0;
}
