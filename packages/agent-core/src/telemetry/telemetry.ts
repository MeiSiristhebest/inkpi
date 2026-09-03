import type {
  AssistantMessage,
  CreativeInteractionMetrics,
  TelemetryEvent,
  TelemetrySpan,
  TelemetryStats,
  Usage
} from '@inkpi/protocol';
import type { Clock } from '../ports/index.js';

/**
 * OpenTelemetry 规范全链路可观测性度量收集器。
 *
 * 契约：
 * - `startTurn()` / `endTurn()` 界定一个 turn；`getStats()` / `getMetrics()` 是纯读，
 *   不会终结 turn 或发射 `turn_telemetry` 事件（终结请用显式的 `endTurn()`）。
 * - 所有时间戳来自可注入的 `clock`（默认即 `Date.now`），便于测试冻结时间。
 * - 支持 4 阶段多 Agent 流水线 Span 分段、TTFT 首字延迟、Prompt Caching 命中率、
 *   以及 Ghost Text 采纳漏斗、分支回滚与状态不变量冲突拦截等遥测度量。
 */
/**
 * 把任意 span id 确定性地映射为 OTel 合法长度的十六进制 id。
 * OTel 要求 traceId 为 32 个 hex 字符、spanId 为 16 个 hex 字符；
 * `inkpi_trace_` 前缀串会被任何标准后端拒绝。同一来源 id 恒定映射（可复现）。
 */
function toOtelHexId(source: string, length: number): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    const c = source.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x01000193) >>> 0;
  }
  const hex = h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  return hex.padEnd(length, '0').slice(0, length);
}

export class TelemetryCollector {
  private clock: Clock;
  private startTime = 0;
  private firstTokenTime: number | null = null;
  private endTime: number | null = null;
  private totalOutputTokens = 0;
  private inputTokens = 0;
  private cacheReadTokens = 0;
  private thinkingTokens = 0;
  private spans: TelemetrySpan[] = [];
  private activeSpans = new Map<string, TelemetrySpan>();
  private eventListeners: Array<(event: TelemetryEvent) => void> = [];

  // Creative Interaction Metrics
  private ghostMetrics = {
    totalSuggestions: 0,
    acceptedFull: 0,
    acceptedWord: 0,
    acceptedLine: 0,
    dismissed: 0,
    acceptedChars: 0,
    dismissedChars: 0
  };

  private branchMetrics = {
    branchCount: 0,
    rollbackCount: 0
  };

  private invariantMetrics = {
    conflictsBlockedCount: 0,
    conflictRules: new Set<string>()
  };

  /**
   * 成本估算单价（USD / 1M tokens）。
   * 默认值只是**占位示例价**，不是任何真实厂商的报价——
   * 生产环境必须经构造函数注入真实价目，否则 costUsd 仅有相对比较意义。
   */
  private modelInputCostPerM = 2.0;
  private modelOutputCostPerM = 8.0;
  private modelCacheReadCostPerM = 0.5;

  /** 成本单价（USD / 1M tokens），可部分覆盖。 */
  constructor(
    clock: Clock,
    pricing?: { inputUsdPerMTokens?: number; outputUsdPerMTokens?: number; cacheReadUsdPerMTokens?: number }
  ) {
    this.clock = clock;
    if (pricing?.inputUsdPerMTokens !== undefined) this.modelInputCostPerM = pricing.inputUsdPerMTokens;
    if (pricing?.outputUsdPerMTokens !== undefined) this.modelOutputCostPerM = pricing.outputUsdPerMTokens;
    if (pricing?.cacheReadUsdPerMTokens !== undefined) this.modelCacheReadCostPerM = pricing.cacheReadUsdPerMTokens;
  }

  public onEvent(listener: (event: TelemetryEvent) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx !== -1) this.eventListeners.splice(idx, 1);
    };
  }

  private emitEvent(event: TelemetryEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  public startTurn(): void {
    this.startTime = this.clock();
    this.firstTokenTime = null;
    this.endTime = null;
    this.totalOutputTokens = 0;
    this.inputTokens = 0;
    this.cacheReadTokens = 0;
    this.thinkingTokens = 0;
    this.spans = [];
    this.activeSpans.clear();
  }

  public recordFirstToken(): void {
    if (this.firstTokenTime === null) {
      this.firstTokenTime = this.clock();
    }
  }

  public recordUsage(usage: AssistantMessage['usage']): void {
    if (!usage) return;
    this.inputTokens += usage.inputTokens || 0;
    this.totalOutputTokens += usage.outputTokens || 0;
    this.cacheReadTokens += usage.cacheReadTokens || 0;
    this.thinkingTokens += usage.reasoningTokens || 0;
  }

  /**
   * 记录用户幽灵文本交互（采纳全量、单字、单行或拒绝）
   */
  public recordGhostTextInteraction(
    action: 'accept_full' | 'accept_word' | 'accept_line' | 'dismiss',
    charCount: number
  ): void {
    this.ghostMetrics.totalSuggestions += 1;
    if (action === 'accept_full') {
      this.ghostMetrics.acceptedFull += 1;
      this.ghostMetrics.acceptedChars += charCount;
    } else if (action === 'accept_word') {
      this.ghostMetrics.acceptedWord += 1;
      this.ghostMetrics.acceptedChars += charCount;
    } else if (action === 'accept_line') {
      this.ghostMetrics.acceptedLine += 1;
      this.ghostMetrics.acceptedChars += charCount;
    } else if (action === 'dismiss') {
      this.ghostMetrics.dismissed += 1;
      this.ghostMetrics.dismissedChars += charCount;
    }

    this.emitEvent({
      type: 'ghost_text_interaction',
      action,
      charCount,
      timestamp: this.clock()
    });
  }

  /**
   * 记录创意分支创建与回滚
   */
  public recordBranchCreation(): void {
    this.branchMetrics.branchCount += 1;
  }

  public recordBranchReversion(branchId: string, depth = 1): void {
    this.branchMetrics.rollbackCount += 1;
    this.emitEvent({
      type: 'branch_rollback',
      branchId,
      depth,
      timestamp: this.clock()
    });
  }

  /**
   * 记录世界状态账本冲突拦截
   */
  public recordInvariantConflict(rule: string, details?: string): void {
    this.invariantMetrics.conflictsBlockedCount += 1;
    this.invariantMetrics.conflictRules.add(rule);
    this.emitEvent({
      type: 'invariant_conflict',
      rule,
      details,
      timestamp: this.clock()
    });
  }

  public getCreativeMetrics(): CreativeInteractionMetrics {
    const totalAccepted =
      this.ghostMetrics.acceptedFull + this.ghostMetrics.acceptedWord + this.ghostMetrics.acceptedLine;
    const totalDecisions = totalAccepted + this.ghostMetrics.dismissed;
    const acceptanceRate = totalDecisions > 0 ? totalAccepted / totalDecisions : 0;

    const totalBranches = Math.max(1, this.branchMetrics.branchCount);
    const rollbackRate = this.branchMetrics.rollbackCount / totalBranches;

    return {
      ghostText: {
        totalSuggestions: this.ghostMetrics.totalSuggestions,
        acceptedFull: this.ghostMetrics.acceptedFull,
        acceptedWord: this.ghostMetrics.acceptedWord,
        acceptedLine: this.ghostMetrics.acceptedLine,
        dismissed: this.ghostMetrics.dismissed,
        acceptedChars: this.ghostMetrics.acceptedChars,
        dismissedChars: this.ghostMetrics.dismissedChars,
        acceptanceRate: Math.round(acceptanceRate * 1000) / 1000
      },
      branching: {
        branchCount: this.branchMetrics.branchCount,
        rollbackCount: this.branchMetrics.rollbackCount,
        rollbackRate: Math.round(rollbackRate * 1000) / 1000
      },
      invariants: {
        conflictsBlockedCount: this.invariantMetrics.conflictsBlockedCount,
        conflictRules: Array.from(this.invariantMetrics.conflictRules)
      }
    };
  }

  /**
   * 启动一个 OpenTelemetry 追踪 Span (如流水线单角色耗时阶段)
   */
  public startSpan(name: string, stage?: string, role?: string, attributes?: Record<string, unknown>): TelemetrySpan {
    const span: TelemetrySpan = {
      id: `span_${this.clock()}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      stage,
      role,
      startTime: this.clock(),
      attributes: attributes || {}
    };
    this.activeSpans.set(span.id, span);
    return span;
  }

  /**
   * 结束 Span 并结算 Token 与耗时
   */
  public endSpan(spanId: string, usage?: Usage, error?: string): TelemetrySpan | undefined {
    const span = this.activeSpans.get(spanId);
    if (!span) return undefined;

    span.endTime = this.clock();
    span.durationMs = Math.max(1, span.endTime - span.startTime);

    if (usage) {
      span.inputTokens = usage.inputTokens;
      span.outputTokens = usage.outputTokens;
      span.cachedTokens = usage.cacheReadTokens;
      span.thinkingTokens = usage.reasoningTokens;
      span.costUsd =
        ((usage.inputTokens || 0) / 1_000_000) * this.modelInputCostPerM +
        ((usage.outputTokens || 0) / 1_000_000) * this.modelOutputCostPerM +
        ((usage.cacheReadTokens || 0) / 1_000_000) * this.modelCacheReadCostPerM;

      this.recordUsage(usage);
    }

    if (error && span.attributes) {
      span.attributes.error = error;
    }

    this.spans.push(span);
    this.activeSpans.delete(spanId);
    return span;
  }

  public getSpans(): TelemetrySpan[] {
    return [...this.spans];
  }

  private computeStats(): TelemetryStats {
    const endTime = this.endTime ?? this.clock();
    const durationMs = Math.max(1, endTime - this.startTime);
    const ttftMs = this.firstTokenTime ? this.firstTokenTime - this.startTime : 0;
    const tokensPerSecond = this.totalOutputTokens / (durationMs / 1000);

    const totalInput = this.inputTokens + this.cacheReadTokens;
    const cacheHitRate = totalInput > 0 ? this.cacheReadTokens / totalInput : 0;

    const estimatedCostUsd =
      (this.inputTokens / 1_000_000) * this.modelInputCostPerM +
      (this.totalOutputTokens / 1_000_000) * this.modelOutputCostPerM +
      (this.cacheReadTokens / 1_000_000) * this.modelCacheReadCostPerM;

    const stats: TelemetryStats = {
      ttftMs,
      totalDurationMs: durationMs,
      tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100000) / 100000,
      thinkingTokens: this.thinkingTokens,
      spans: this.getSpans(),
      creativeMetrics: this.getCreativeMetrics()
    };

    return stats;
  }

  /** Finalize the current turn: snapshot stats and emit a `turn_telemetry` event. */
  public endTurn(): TelemetryStats {
    this.endTime = this.clock();
    const stats = this.computeStats();
    this.emitEvent({
      type: 'turn_telemetry',
      stats,
      timestamp: this.clock()
    });
    return stats;
  }

  /** Read-only snapshot of current turn stats. Does NOT finalize the turn or emit events. */
  public getStats(): TelemetryStats {
    return this.computeStats();
  }

  /** Alias of {@link getStats} for metric-oriented callers. Pure read. */
  public getMetrics(): TelemetryStats {
    return this.computeStats();
  }

  public reset(): void {
    this.startTurn();
    this.ghostMetrics = {
      totalSuggestions: 0,
      acceptedFull: 0,
      acceptedWord: 0,
      acceptedLine: 0,
      dismissed: 0,
      acceptedChars: 0,
      dismissedChars: 0
    };
    this.branchMetrics = {
      branchCount: 0,
      rollbackCount: 0
    };
    this.invariantMetrics = {
      conflictsBlockedCount: 0,
      conflictRules: new Set<string>()
    };
  }

  /**
   * 导出为 OpenTelemetry JSON 格式 payload
   */
  public exportOpenTelemetryJson(): string {
    const stats = this.computeStats();
    return JSON.stringify(
      {
        resourceSpans: [
          {
            resource: {
              attributes: [
                { key: 'service.name', value: { stringValue: 'inkpi-agent-engine' } },
                { key: 'service.version', value: { stringValue: '1.0.0' } }
              ]
            },
            scopeSpans: [
              {
                scope: { name: 'inkpi-agent-coordinator' },
                spans: stats.spans?.map((s) => ({
                  traceId: toOtelHexId(s.id, 32),
                  spanId: toOtelHexId(`${s.id}:span`, 16),
                  name: s.name,
                  startTimeUnixNano: s.startTime * 1_000_000,
                  endTimeUnixNano: (s.endTime || this.clock()) * 1_000_000,
                  attributes: [
                    { key: 'agent.stage', value: { stringValue: s.stage || 'unknown' } },
                    { key: 'agent.role', value: { stringValue: s.role || 'unknown' } },
                    { key: 'tokens.input', value: { intValue: s.inputTokens || 0 } },
                    { key: 'tokens.output', value: { intValue: s.outputTokens || 0 } },
                    { key: 'tokens.cached', value: { intValue: s.cachedTokens || 0 } },
                    { key: 'cost.usd', value: { doubleValue: s.costUsd || 0 } }
                  ]
                }))
              }
            ]
          }
        ]
      },
      null,
      2
    );
  }
}
