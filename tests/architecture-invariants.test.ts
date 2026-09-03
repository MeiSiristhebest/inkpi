import type { ModelConfig } from '@inkpi/ai';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Architectural guard tests
//
// These encode the invariants established during the architecture-review
// remediation so that CI fails loudly if a future change reintroduces a
// silent-fake model, a silent provider fallback, or a silent
// "no model configured" path.
//
// They intentionally re-import @inkpi/ai / @inkpi/agent-core with a RESET module
// registry so the *production* (test-doubles-not-installed) state is observed,
// rather than the test-double state installed by tests/setup.ts.
// ---------------------------------------------------------------------------

function fakeModel(provider: string): ModelConfig {
  return { id: 'invariant-x', name: 'invariant-x', provider } as ModelConfig;
}

describe('Architecture invariants (no silent fake / DIP regressions)', () => {
  it('production @inkpi/ai does NOT register the mock-test fixture by default', async () => {
    vi.resetModules();
    const ai = await import('@inkpi/ai');
    // mock-test is a test double, only present after installTestDoubles().
    expect(ai.hasModelPreset('mock-test')).toBe(false);
  });

  it('unknown providers fail loudly instead of silently mapping to a fake', async () => {
    vi.resetModules();
    const ai = await import('@inkpi/ai');
    const stream = ai.streamAi(fakeModel('totally-unknown-provider'), []);
    const result = await stream.collect();
    expect(result.stopReason).toBe('error');
    expect(String(result.errorMessage || '')).toMatch(/not registered/i);
  });

  it('unimplemented providers (azure/bedrock) throw instead of silent fallback', async () => {
    vi.resetModules();
    const ai = await import('@inkpi/ai');
    expect(() => ai.streamAi(fakeModel('azure'), [])).toThrow(/not implemented/i);
    expect(() => ai.streamAi(fakeModel('bedrock'), [])).toThrow(/not implemented/i);
  });

  it('a session without a configured model fails loudly (no silent mock)', async () => {
    vi.resetModules();
    const { SessionRegistry } = await import('@inkpi/agent-core');
    const sm = new SessionRegistry(Date.now);
    expect(() => sm.createSession({ sessionId: 'invariant-session' })).toThrow();
  });

  it('explicit test doubles install cleanly and the mock-test path responds', async () => {
    vi.resetModules();
    const ai = await import('@inkpi/ai');
    ai.installTestDoubles();
    expect(ai.hasModelPreset('mock-test')).toBe(true);
    const model = ai.getModelPreset('mock-test');
    const stream = ai.streamAi(model, []);
    const result = await stream.collect();
    expect(result.stopReason).not.toBe('error');
    expect(JSON.stringify(result.content)).toContain('Faux test response');
  });
});
