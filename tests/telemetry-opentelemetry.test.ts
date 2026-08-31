import { TelemetryCollector, WorkflowCoordinator } from '@inkpi/agent-core';
import { getModelPreset } from '@inkpi/ai';

describe('OpenTelemetry Spans & Multi-Agent Telemetry Metrics', () => {
  it('should track spans, tokens, TTFT, and export valid OpenTelemetry JSON', () => {
    const telem = new TelemetryCollector();
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
    const telem = new TelemetryCollector();
    const pipeline = new WorkflowCoordinator({ telemetry: telem, model });

    const result = await pipeline.runPipeline(
      'Test Workspace B',
      'Document 1 Start',
      '主角初入World'
    );
    expect(result.polishedText).toBeDefined();

    const spans = telem.getSpans();
    expect(spans.length).toBe(4);
    expect(spans.map((s) => s.stage)).toEqual(['outline', 'draft', 'audit', 'polish']);
    expect(spans.map((s) => s.role)).toEqual(['architect', 'writer', 'auditor', 'polisher']);

    const stats = telem.endTurn();
    expect(stats.spans?.length).toBe(4);
  });

  it('should handle edge cases in span lifecycle and usage calculations', () => {
    const telem = new TelemetryCollector();
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
