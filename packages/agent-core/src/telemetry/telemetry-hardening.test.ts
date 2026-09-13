import { describe, expect, it } from 'vitest';
import { TelemetryCollector } from './telemetry.js';

describe('telemetry collector health and privacy boundary', () => {
  it('contains event listener failures and exposes collector health', () => {
    const collector = new TelemetryCollector(() => 10);
    collector.onEvent(() => {
      throw new Error('listener failure');
    });

    collector.startTurn();
    expect(() => collector.recordGhostTextInteraction('dismiss', 1)).not.toThrow();

    expect(collector.getHealth()).toEqual({
      healthy: false,
      eventListenerErrors: 1,
      lastErrorAt: 10
    });
  });

  it('sanitizes span attributes and returns defensive span snapshots', () => {
    const collector = new TelemetryCollector(() => 10);
    const span = collector.startSpan('safe-span', 'stage', 'role', {
      publicValue: 'safe',
      prompt: 'full prompt',
      apiKey: 'secret-value'
    });
    collector.endSpan(span.id, undefined, 'api_key=sk-sensitive');

    const firstRead = collector.getSpans();
    expect(firstRead[0]?.attributes).toEqual({ publicValue: 'safe', error: '[REDACTED]' });
    if (firstRead[0]?.attributes) firstRead[0].attributes.publicValue = 'mutated';
    expect(collector.getSpans()[0]?.attributes?.publicValue).toBe('safe');
    expect(JSON.stringify(collector.getSpans())).not.toContain('sk-sensitive');
  });
});
