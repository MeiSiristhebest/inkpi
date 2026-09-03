import { TelemetryCollector } from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core -> Telemetry Collector (1:1 Ported from repos/pi)', () => {
  it('should foreshadowing TTFT, tokens per second, prompt caching hit rate, and estimated costs', async () => {
    const collector = new TelemetryCollector(Date.now);

    collector.startTurn();

    // Simulate TTFT
    await new Promise((resolve) => setTimeout(resolve, 20));
    collector.recordFirstToken();

    // Record usage with prompt cache hits
    collector.recordUsage({
      inputTokens: 2000,
      outputTokens: 500,
      totalTokens: 2500,
      cacheReadTokens: 8000 // 8k cached tokens from worldworkspace
    });

    const stats = collector.endTurn();

    expect(stats.ttftMs).toBeGreaterThanOrEqual(10);
    expect(stats.tokensPerSecond).toBeGreaterThan(0);
    // Cache hit rate = 8000 / (2000 + 8000) = 0.8
    expect(stats.cacheHitRate).toBe(0.8);
    expect(stats.estimatedCostUsd).toBeGreaterThan(0);
  });
});
