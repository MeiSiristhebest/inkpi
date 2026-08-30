import type { TelemetryStats, AssistantMessage, TelemetrySpan, Usage } from '@inkpi/protocol';

/**
 * OpenTelemetry 规范全链路可观测性度量收集器 (1:1 对标 repos/pi packages/telemetry)
 * 支持 4 阶段多 Agent 流水线 Span 分段、TTFT 首字延迟、Prompt Caching 命中率与成本核算
 */
export class TelemetryCollector {
  private startTime = 0;
  private firstTokenTime: number | null = null;
  private endTime: number | null = null;
  private totalOutputTokens = 0;
  private inputTokens = 0;
  private cacheReadTokens = 0;
  private thinkingTokens = 0;
  private spans: TelemetrySpan[] = [];
  private activeSpans = new Map<string, TelemetrySpan>();

  private modelInputCostPerM = 2.0; // Default $2 / 1M tokens
  private modelOutputCostPerM = 8.0; // Default $8 / 1M tokens
  private modelCacheReadCostPerM = 0.5; // Default $0.5 / 1M tokens

  public startTurn(): void {
    this.startTime = Date.now();
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
      this.firstTokenTime = Date.now();
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
   * 启动一个 OpenTelemetry 追踪 Span (如流水线单角色耗时阶段)
   */
  public startSpan(name: string, stage?: string, role?: string, attributes?: Record<string, unknown>): TelemetrySpan {
    const span: TelemetrySpan = {
      id: `span_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name,
      stage,
      role,
      startTime: Date.now(),
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

    span.endTime = Date.now();
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

  public endTurn(): TelemetryStats {
    this.endTime = Date.now();
    const durationMs = Math.max(1, this.endTime - this.startTime);
    const ttftMs = this.firstTokenTime ? this.firstTokenTime - this.startTime : 0;
    const tokensPerSecond = (this.totalOutputTokens / (durationMs / 1000));

    const totalInput = this.inputTokens + this.cacheReadTokens;
    const cacheHitRate = totalInput > 0 ? this.cacheReadTokens / totalInput : 0;

    const estimatedCostUsd =
      (this.inputTokens / 1_000_000) * this.modelInputCostPerM +
      (this.totalOutputTokens / 1_000_000) * this.modelOutputCostPerM +
      (this.cacheReadTokens / 1_000_000) * this.modelCacheReadCostPerM;

    return {
      ttftMs,
      totalDurationMs: durationMs,
      tokensPerSecond: Math.round(tokensPerSecond * 10) / 10,
      cacheHitRate: Math.round(cacheHitRate * 100) / 100,
      estimatedCostUsd: Math.round(estimatedCostUsd * 100000) / 100000,
      thinkingTokens: this.thinkingTokens,
      spans: this.getSpans()
    };
  }

  public getStats(): TelemetryStats {
    return this.endTurn();
  }

  public getMetrics(): TelemetryStats {
    return this.endTurn();
  }

  /**
   * 导出为 OpenTelemetry JSON 格式 payload
   */
  public exportOpenTelemetryJson(): string {
    const stats = this.endTurn();
    return JSON.stringify({
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
                traceId: 'inkpi_trace_' + s.id,
                spanId: s.id,
                name: s.name,
                startTimeUnixNano: s.startTime * 1_000_000,
                endTimeUnixNano: (s.endTime || Date.now()) * 1_000_000,
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
    }, null, 2);
  }
}
