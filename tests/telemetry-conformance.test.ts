import { TelemetryCollector } from '@inkpi/agent-core';
import type { TelemetryEvent } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('Creative Telemetry & Conformance Suite (1:1 Ported from pi-telemetry)', () => {
  it('should collect turn metrics, spans, and creative interaction metrics accurately', () => {
    const collector = new TelemetryCollector(Date.now);
    const events: TelemetryEvent[] = [];
    const unsubscribe = collector.onEvent((ev) => events.push(ev));

    collector.startTurn();
    collector.recordFirstToken();

    // 1. Spans & Token usage
    const span1 = collector.startSpan('narrative_outline', 'outline', 'architect');
    collector.endSpan(span1.id, {
      inputTokens: 1000,
      outputTokens: 300,
      cacheReadTokens: 500,
      reasoningTokens: 100,
      totalTokens: 1900
    });

    // 2. Creative Ghost Text interactions
    collector.recordGhostTextInteraction('accept_full', 50);
    collector.recordGhostTextInteraction('accept_word', 5);
    collector.recordGhostTextInteraction('accept_line', 20);
    collector.recordGhostTextInteraction('dismiss', 15);

    // 3. Branching & Rollbacks
    collector.recordBranchCreation();
    collector.recordBranchCreation();
    collector.recordBranchReversion('branch_draft_v2', 2);

    // 4. Invariant conflict blocking
    collector.recordInvariantConflict('character_status_conflict', 'User was dead but actively spoke');
    collector.recordInvariantConflict('character_status_conflict', 'Duplicate violation');
    collector.recordInvariantConflict('item_possession_conflict', 'Item held by another');

    // 5. Check stats
    const stats = collector.getStats();
    // getStats() is a pure read; finalize the turn explicitly to emit turn_telemetry.
    collector.endTurn();
    expect(stats.ttftMs).toBeGreaterThanOrEqual(0);
    expect(stats.totalDurationMs).toBeGreaterThanOrEqual(1);
    expect(stats.spans?.length).toBe(1);

    const creative = stats.creativeMetrics!;
    expect(creative).toBeDefined();

    // Ghost text calculations
    expect(creative.ghostText.totalSuggestions).toBe(4);
    expect(creative.ghostText.acceptedFull).toBe(1);
    expect(creative.ghostText.acceptedWord).toBe(1);
    expect(creative.ghostText.acceptedLine).toBe(1);
    expect(creative.ghostText.dismissed).toBe(1);
    expect(creative.ghostText.acceptedChars).toBe(75);
    expect(creative.ghostText.dismissedChars).toBe(15);
    expect(creative.ghostText.acceptanceRate).toBe(0.75); // 3 accepted out of 4 total = 0.75

    // Branching calculations
    expect(creative.branching.branchCount).toBe(2);
    expect(creative.branching.rollbackCount).toBe(1);
    expect(creative.branching.rollbackRate).toBe(0.5); // 1 rollback out of 2 branches = 0.5

    // Invariants calculations
    expect(creative.invariants.conflictsBlockedCount).toBe(3);
    expect(creative.invariants.conflictRules).toContain('character_status_conflict');
    expect(creative.invariants.conflictRules).toContain('item_possession_conflict');
    expect(creative.invariants.conflictRules.length).toBe(2); // Set deduplication

    // Events emitted
    expect(events.some((e) => e.type === 'ghost_text_interaction')).toBe(true);
    expect(events.some((e) => e.type === 'branch_rollback')).toBe(true);
    expect(events.some((e) => e.type === 'invariant_conflict')).toBe(true);
    expect(events.some((e) => e.type === 'turn_telemetry')).toBe(true);

    // 6. OpenTelemetry JSON export
    const otelJson = collector.exportOpenTelemetryJson();
    expect(otelJson).toContain('inkpi-agent-engine');
    expect(otelJson).toContain('narrative_outline');

    // 7. Unsubscribe and Reset
    unsubscribe();
    collector.reset();
    const cleanStats = collector.getStats();
    expect(cleanStats.creativeMetrics?.ghostText.totalSuggestions).toBe(0);
    expect(cleanStats.creativeMetrics?.branching.branchCount).toBe(0);
  });
});
