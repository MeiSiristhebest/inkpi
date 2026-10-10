import { TelemetryCollector, WorkflowCoordinator } from '@inkpi/agent-core';
import { getModelPreset, registerModelCost } from '@inkpi/ai';

describe('OpenTelemetry Spans & Multi-Agent Telemetry Metrics', () => {
  it('should track spans, tokens, TTFT, and export valid OpenTelemetry JSON', () => {
    const telem = new TelemetryCollector(Date.now, {
      inputUsdPerMTokens: 2,
      outputUsdPerMTokens: 8,
      cacheReadUsdPerMTokens: 0.5
    });
    telem.startTurn();

    const span1 = telem.startSpan('architect_stage', 'outline', 'architect');
    telem.recordFirstToken();
    telem.endSpan(span1.id, {
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      cacheReadTokens: 400,
      reasoningTokens: 200
    });

    const span2 = telem.startSpan('writer_stage', 'draft', 'writer');
    telem.endSpan(span2.id, {
      inputTokens: 2000,
      outputTokens: 1200,
      totalTokens: 3200,
      cacheReadTokens: 1000
    });

    const stats = telem.endTurn();
    expect(stats.spans?.length).toBe(2);
    expect(stats.tokensPerSecond).toBeGreaterThan(0);
    expect(stats.cacheHitRate).toBeGreaterThan(0);
    expect(stats.estimatedCostUsd).toBeGreaterThan(0);

    const otelJson = telem.exportOpenTelemetryJson();
    expect(otelJson).toContain('resourceSpans');
    expect(otelJson).toContain('inkpi-agent-engine');
    expect(otelJson).toContain('architect');
    expect(otelJson).toContain('writer');
  });

  it('should collect OpenTelemetry spans automatically during 4-phase pipeline execution', async () => {
    const model = getModelPreset('mock-test');
    model.fauxScript = { text: 'telemetry provider output', inputTokens: 5, outputTokens: 7 };
    registerModelCost({
      id: model.id,
      name: 'Telemetry Workflow Model',
      provider: 'openai',
      contextWindow: 1_000_000,
      maxTokens: 16_000,
      supportsThinking: false,
      supportsTools: true,
      cost: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 }
    });
    const telem = new TelemetryCollector(Date.now);
    const pipeline = new WorkflowCoordinator({
      telemetry: telem,
      model,
      stages: [
        { id: 'outline', name: '大纲', role: 'architect' },
        { id: 'draft', name: '正文', role: 'writer' },
        { id: 'audit', name: '审计', role: 'auditor' },
        { id: 'polish', name: '润色', role: 'polisher' }
      ]
    });

    const result = await pipeline.runWorkflow({
      title: 'Test Workspace B',
      sectionTitle: 'Document 1 Start',
      userPrompt: '主角初入World'
    });
    expect(result.stageOutputs.polish).toBeDefined();

    const spans = telem.getSpans();
    expect(spans.length).toBe(4);
    expect(spans.map((s) => s.stage)).toEqual(['outline', 'draft', 'audit', 'polish']);
    expect(spans.map((s) => s.role)).toEqual(['architect', 'writer', 'auditor', 'polisher']);

    const stats = telem.endTurn();
    expect(stats.spans?.length).toBe(4);
    expect(stats.estimatedCostUsd).toBeCloseTo(0.00008, 9);
    expect(stats.estimatedCostStatus).toBe('known');
    expect(stats.spans?.every((span) => span.costStatus === 'known')).toBe(true);
  });

  it('uses catalog tier prices and reports missing prices as unknown', () => {
    registerModelCost({
      id: 'telemetry-tiered-model',
      name: 'Telemetry Tiered Model',
      provider: 'openai',
      contextWindow: 1_000_000,
      maxTokens: 16_000,
      supportsThinking: false,
      supportsTools: true,
      cost: {
        inputPerMillionUsd: 1,
        outputPerMillionUsd: 2,
        cacheReadPerMillionUsd: 0.5,
        cacheWritePerMillionUsd: 1,
        serviceTierRates: { priority: { inputPerMillionUsd: 2, outputPerMillionUsd: 3 } },
        promptLengthTiers: [{ minimumPromptTokens: 100_000, rates: { inputPerMillionUsd: 4, outputPerMillionUsd: 5 } }],
        cacheWritePerMillionUsdByTtl: { '5m': 3, '1h': 6 }
      }
    });

    const telem = new TelemetryCollector(() => 10);
    telem.startTurn();
    const span = telem.startSpan('writer', 'draft', 'writer');
    telem.endSpan(
      span.id,
      {
        inputTokens: 100_000,
        outputTokens: 50_000,
        promptTokens: 100_000,
        serviceTier: 'priority',
        cacheReadTokens: 10_000,
        cacheWriteTokens: 40_000,
        cacheWrite5mTokens: 20_000,
        cacheWrite1hTokens: 20_000,
        totalTokens: 150_000
      },
      undefined,
      'telemetry-tiered-model'
    );

    const stats = telem.endTurn();
    expect(span.costUsd).toBeCloseTo(0.835, 6);
    expect(span.costStatus).toBe('known');
    expect(stats.estimatedCostUsd).toBeCloseTo(0.835, 6);
    expect(stats.estimatedCostStatus).toBe('known');

    const unknown = new TelemetryCollector(() => 10);
    unknown.startTurn();
    unknown.recordUsage({ inputTokens: 100, outputTokens: 50, totalTokens: 150 });
    const unknownStats = unknown.endTurn();
    expect(unknownStats.estimatedCostUsd).toBe(0);
    expect(unknownStats.estimatedCostStatus).toBe('unknown');

    const partial = new TelemetryCollector(() => 10, { inputUsdPerMTokens: 2 });
    partial.startTurn();
    partial.recordUsage({ inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 });
    const partialStats = partial.endTurn();
    expect(partialStats.estimatedCostUsd).toBe(2);
    expect(partialStats.estimatedCostStatus).toBe('partial');
  });

  it('should handle edge cases in span lifecycle and usage calculations', () => {
    const telem = new TelemetryCollector(Date.now);
    telem.startTurn();

    // Span with error
    const span = telem.startSpan('error_stage', 'test', 'tester');
    telem.endSpan(span.id, undefined, 'Simulated stage error');

    const notFound = telem.endSpan('non_existent_span');
    expect(notFound).toBeUndefined();

    // Record empty usage
    telem.recordUsage(undefined);

    const stats = telem.endTurn();
    expect(stats.spans?.length).toBe(1);
    expect(stats.spans?.[0].attributes?.error).toBe('Simulated stage error');
  });
});
