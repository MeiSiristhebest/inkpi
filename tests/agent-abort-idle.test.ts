import { Agent } from '@inkpi/agent-core';
import { getModelPreset } from '@inkpi/ai';
import { describe, expect, it } from 'vitest';

function createIdleAgent(): Agent {
  return new Agent({ initialState: { model: getModelPreset('mock-test') } });
}

describe('@inkpi/agent-core -> abort/idle semantics with compaction (aligned with pi v0.85.0 #8920)', () => {
  it('reports idle when no run and no compaction is active', () => {
    const agent = createIdleAgent();
    expect(agent.isIdle).toBe(true);
    expect(agent.isCompacting).toBe(false);
  });

  it('tracks in-flight manual compaction in idle state and waitForIdle', async () => {
    const agent = createIdleAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const compaction = agent.runCompaction(async (_signal) => {
      await gate;
      return 'compacted';
    });

    expect(agent.isCompacting).toBe(true);
    expect(agent.isIdle).toBe(false);

    // waitForIdle 在 compaction 落定前挂起，落定后恢复。
    let idleSettled = false;
    const idlePromise = agent.waitForIdle().then(() => {
      idleSettled = true;
      return 'idle';
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(idleSettled).toBe(false);

    release();
    await expect(compaction).resolves.toBe('compacted');
    await expect(idlePromise).resolves.toBe('idle');
    expect(agent.isIdle).toBe(true);
    expect(agent.isCompacting).toBe(false);
  });

  it('abort() cancels an in-flight compaction via its signal and waits for it to settle', async () => {
    const agent = createIdleAgent();

    const compaction = agent.runCompaction(
      (signal) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('Session compaction aborted by signal')), {
            once: true
          });
        })
    );

    await agent.abort();

    await expect(compaction).rejects.toThrow('Session compaction aborted by signal');
    expect(agent.isIdle).toBe(true);
    expect(agent.isCompacting).toBe(false);
  });

  it('rejects concurrent manual compactions', async () => {
    const agent = createIdleAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const first = agent.runCompaction(async () => {
      await gate;
      return 1;
    });

    await expect(agent.runCompaction(async () => 2)).rejects.toThrow('already in progress');

    release();
    await first;
    // 落定后可再次启动。
    await expect(agent.runCompaction(async () => 3)).resolves.toBe(3);
  });

  it('reset() refuses while a compaction is in progress', async () => {
    const agent = createIdleAgent();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const compaction = agent.runCompaction(async () => {
      await gate;
      return 'x';
    });

    expect(() => agent.reset()).toThrow('compaction');

    release();
    await compaction;
    expect(() => agent.reset()).not.toThrow();
  });
});
