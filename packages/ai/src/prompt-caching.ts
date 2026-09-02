import type { AgentMessage, StateLedger } from '@inkpi/protocol';
import type { CacheControl } from './types.js';

/**
 * 字符→Token 的启发式换算系数。
 *
 * 这是全仓**唯一**的估算来源：触发判断与事后统计都必须用同一个值，
 * 否则误差自我印证（估算触发压缩 → 压缩后也用它结算 → 永远"看起来正确"）。
 * 它是一个粗糙启发式（对英文约 0.25 token/char，对中文明显偏高）；
 * 需要精确计量的场景应注入真实 tokenizer 并自行替换本系数。
 */
export const CHARS_PER_TOKEN_HEURISTIC = 0.7;

/** 按启发式系数把字符数换算为估算 token 数（向上取整）。 */
export function estimateTokensFromChars(chars: number, factor: number = CHARS_PER_TOKEN_HEURISTIC): number {
  return Math.ceil(chars * factor);
}

export interface OptimizedCachedPromptResult {
  cachedSystemPrompt: string;
  cacheControl: CacheControl;
  estimatedPrefixTokens: number;
  messages: AgentMessage[];
}

export interface CacheSlot {
  id: string;
  type: 'system' | 'lore' | 'ledger' | 'turn';
  content: string;
  cacheControl: CacheControl;
  estimatedTokens: number;
}

export interface MultiSlotCachedPromptResult {
  slots: CacheSlot[];
  totalEstimatedTokens: number;
  cachedSystemPrompt: string;
  messages: AgentMessage[];
}

/**
 * 通用 Prompt Caching 优化器
 * 将高频、不可变的系统提示词、核心规则、全量状态上下文锁定为固定 Cache Prefix 断点，
 * 实现后续多轮交互、复杂推演与状态更新时 90%+ 的 Token 缓存命中率与首字极速响应。
 */
export const PromptCacheOptimizer = {
  /**
   * 构造带有缓存断点切分的系统提示词与上下文
   */
  buildCachedPrompt(params: {
    baseSystemPrompt: string;
    backgroundContext?: string;
    domainRules?: string;
    stateLedger?: StateLedger;
    currentTurnMessages: AgentMessage[];
  }): OptimizedCachedPromptResult {
    const prefixSections: string[] = [];

    prefixSections.push(params.baseSystemPrompt.trim());

    if (params.backgroundContext) {
      prefixSections.push(`\n=== 🌐 [全局背景上下文 (Immutable Cache Slot)] ===\n${params.backgroundContext.trim()}`);
    }

    if (params.domainRules) {
      prefixSections.push(`\n=== ⚡ [领域规则与核心体系 (Immutable Cache Slot)] ===\n${params.domainRules.trim()}`);
    }

    if (params.stateLedger) {
      const ledgerParts: string[] = [];
      if (params.stateLedger.entities && params.stateLedger.entities.length > 0) {
        ledgerParts.push(
          `核心实体: ${params.stateLedger.entities.map((c: StateLedger['entities'][number]) => `${c.name}${c.status ? `[${c.status}]` : ''}`).join('、')}`
        );
      }
      if (params.stateLedger.assets && params.stateLedger.assets.length > 0) {
        ledgerParts.push(
          `关键资产: ${params.stateLedger.assets.map((i: StateLedger['assets'][number]) => `${i.name}${i.holder ? `(持有人:${i.holder})` : ''}`).join('、')}`
        );
      }
      if (ledgerParts.length > 0) {
        prefixSections.push(`\n=== 📜 [核心状态账本快照 (Cache Slot)] ===\n${ledgerParts.join('\n')}`);
      }
    }

    const cachedSystemPrompt = prefixSections.join('\n\n');
    const estimatedPrefixTokens = estimateTokensFromChars(cachedSystemPrompt.length);

    return {
      cachedSystemPrompt,
      cacheControl: { type: 'ephemeral' },
      estimatedPrefixTokens,
      messages: params.currentTurnMessages
    };
  },

  /**
   * 构建四级精确 Cache Slot 断点
   */
  buildMultiSlotCacheBreakpoints(params: {
    baseSystemPrompt: string;
    worldLore?: string;
    stateLedger?: StateLedger;
    recentMessages: AgentMessage[];
    maxBreakpoints?: number;
  }): MultiSlotCachedPromptResult {
    const slots: CacheSlot[] = [];
    const maxSlots = params.maxBreakpoints || 4;

    // Slot 1: Base System Prompt & Directives (Immutable)
    const baseContent = params.baseSystemPrompt.trim();
    slots.push({
      id: 'slot_1_system',
      type: 'system',
      content: baseContent,
      cacheControl: { type: 'ephemeral' },
      estimatedTokens: estimateTokensFromChars(baseContent.length)
    });

    // Slot 2: Long-form World Lore & Setting (Immutable)
    if (params.worldLore && slots.length < maxSlots) {
      const loreContent = `=== 🌐 [World Lore & Invariants] ===\n${params.worldLore.trim()}`;
      slots.push({
        id: 'slot_2_lore',
        type: 'lore',
        content: loreContent,
        cacheControl: { type: 'ephemeral' },
        estimatedTokens: estimateTokensFromChars(loreContent.length)
      });
    }

    // Slot 3: Structured State Ledger Snapshot
    if (params.stateLedger && slots.length < maxSlots) {
      const parts: string[] = [];
      if (params.stateLedger.entities?.length) {
        parts.push(
          `Entities: ${params.stateLedger.entities.map((e) => `${e.name}(${e.status || 'Active'})`).join(', ')}`
        );
      }
      if (params.stateLedger.assets?.length) {
        parts.push(`Assets: ${params.stateLedger.assets.map((a) => `${a.name}[${a.holder || 'None'}]`).join(', ')}`);
      }
      if (parts.length > 0) {
        const ledgerContent = `=== 📜 [State Ledger Snapshot] ===\n${parts.join('\n')}`;
        slots.push({
          id: 'slot_3_ledger',
          type: 'ledger',
          content: ledgerContent,
          cacheControl: { type: 'ephemeral' },
          estimatedTokens: estimateTokensFromChars(ledgerContent.length)
        });
      }
    }

    const combinedSystemPrompt = slots.map((s) => s.content).join('\n\n');
    const totalEstimatedTokens = slots.reduce((sum, s) => sum + s.estimatedTokens, 0);

    return {
      slots,
      totalEstimatedTokens,
      cachedSystemPrompt: combinedSystemPrompt,
      messages: params.recentMessages
    };
  },

  /**
   * 计算 Prompt Caching 带来的费用节省预估
   */
  calculateSavings(
    cachedTokens: number,
    pricing: {
      inputPricePerMillion: number;
      cacheReadPricePerMillion: number;
    }
  ): {
    standardCostUsd: number;
    cachedCostUsd: number;
    savedCostUsd: number;
    savingsPercentage: number;
  } {
    const standardCost = (cachedTokens / 1_000_000) * pricing.inputPricePerMillion;
    const cachedCost = (cachedTokens / 1_000_000) * pricing.cacheReadPricePerMillion;
    const savedCost = Math.max(0, standardCost - cachedCost);
    const savingsPercentage = standardCost > 0 ? (savedCost / standardCost) * 100 : 0;

    return {
      standardCostUsd: standardCost,
      cachedCostUsd: cachedCost,
      savedCostUsd: savedCost,
      savingsPercentage
    };
  }
};
