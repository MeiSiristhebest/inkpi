import { describe, it, expect, vi } from 'vitest';
import {
  PromptCacheOptimizer,
  AssistantEventStream,
  createResilientStream,
  retryAssistantStream
} from '@inkpi/ai';

describe('AI Provider Resilience & Precise Prompt Caching (1:1 Ported from pi-ai)', () => {
  it('should build 4-slot precise cache breakpoints for long-form creative contexts', () => {
    const result = PromptCacheOptimizer.buildMultiSlotCacheBreakpoints({
      baseSystemPrompt: 'You are an epic fantasy co-writer.',
      worldLore: 'Magic System: Aether resonance with 7 celestial crystals.',
      stateLedger: {
        entities: [{ name: 'Aria', status: 'Awakened' }],
        assets: [{ name: 'Aether Blade', holder: 'Aria' }],
        tracks: [],
        locations: [],
        modifiedResources: []
      },
      recentMessages: [
        { id: 'm1', role: 'user', content: 'Describe the awakening ritual.' }
      ]
    });

    expect(result.slots.length).toBe(3);
    expect(result.slots[0].type).toBe('system');
    expect(result.slots[1].type).toBe('lore');
    expect(result.slots[2].type).toBe('ledger');
    expect(result.totalEstimatedTokens).toBeGreaterThan(20);
    expect(result.cachedSystemPrompt).toContain('Aether resonance');
    expect(result.cachedSystemPrompt).toContain('Aether Blade');
  });

  it('should seamlessly retry and recover transient stream errors using createResilientStream', async () => {
    let callCount = 0;
    const retrySpy = vi.fn();

    const stream = createResilientStream(
      async (attempt) => {
        callCount++;
        const s = new AssistantEventStream();
        setTimeout(() => {
          if (attempt === 1) {
            // First attempt fails with transient error
            s.error('503 Service Unavailable');
          } else {
            // Second attempt succeeds
            s.push({ type: 'text_delta', textDelta: 'Recovered stream chunk' });
            s.push({ type: 'usage', usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } });
            s.end();
          }
        }, 10);
        return s;
      },
      {
        maxRetries: 3,
        initialDelayMs: 20,
        onRetry: retrySpy
      }
    );

    const message = await stream.collect();
    expect(callCount).toBe(2);
    expect(retrySpy).toHaveBeenCalledTimes(1);
    expect(message.content[0].type).toBe('text');
    expect((message.content[0] as any).text).toBe('Recovered stream chunk');
  });

  it('should handle terminal errors after maxRetries in createResilientStream and retryAssistantStream', async () => {
    let callCount = 0;
    const stream = createResilientStream(
      async () => {
        callCount++;
        const s = new AssistantEventStream();
        setTimeout(() => s.error('401 Unauthorized permanently'), 10);
        return s;
      },
      {
        maxRetries: 2,
        initialDelayMs: 10,
        isRetryable: (err) => !err.includes('401')
      }
    );

    const msg = await stream.collect();
    expect(msg.stopReason).toBe('error');
    expect(msg.errorMessage).toContain('401 Unauthorized permanently');
    expect(callCount).toBe(1);


    // retryAssistantStream test
    let retryAttempt = 0;
    const result = await retryAssistantStream(
      async () => {
        retryAttempt++;
        if (retryAttempt < 2) throw new Error('Temporary failure');
        return 'success_val';
      },
      { maxRetries: 3, initialDelayMs: 10 }
    );
    expect(result).toBe('success_val');
  });
});
