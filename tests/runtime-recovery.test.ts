import { ContextBudgetPlanner, SessionCompactor } from '@inkpi/agent-core';
import { AssistantEventStream, ProviderError, classifyProviderError, retryAssistantStream } from '@inkpi/ai';
import { describe, expect, it } from 'vitest';

describe('runtime provider recovery seams', () => {
  it('preserves structured provider metadata through collect', async () => {
    const stream = new AssistantEventStream();
    stream.error(
      new ProviderError({
        code: 'rate_limit',
        message: 'busy',
        provider: 'z-ai',
        status: 429,
        retryAfterMs: 250,
        maxDelayMs: 1000,
        details: { requestId: 'req-1' }
      })
    );
    await expect(stream.collect()).resolves.toMatchObject({
      stopReason: 'error',
      providerError: {
        code: 'rate_limit',
        provider: 'z-ai',
        status: 429,
        retryAfterMs: 250,
        maxDelayMs: 1000,
        details: { requestId: 'req-1' }
      }
    });
  });

  it('classifies z.ai context overflow as terminal structured failure', () => {
    expect(
      classifyProviderError({
        provider: 'z-ai',
        status: 400,
        message: 'maximum context length exceeded',
        details: { code: 'context_length_exceeded' }
      })
    ).toMatchObject({ code: 'context_overflow', provider: 'z-ai', retryable: false });
  });

  it('does not retry an ordinary Error', async () => {
    let attempts = 0;
    await expect(
      retryAssistantStream(
        async () => {
          attempts += 1;
          throw new Error('ordinary failure');
        },
        { maxRetries: 3, initialDelayMs: 0 }
      )
    ).rejects.toThrow('ordinary failure');
    expect(attempts).toBe(1);
  });

  it('plans first-call input budget with output reserve', () => {
    const planner = new ContextBudgetPlanner();
    expect(
      planner.plan({ contextWindowTokens: 100, outputReserveTokens: 20, estimatedInputTokens: 81, messages: [] })
    ).toMatchObject({ inputBudgetTokens: 80, overBudget: true, firstCall: true });
  });

  it('compacts rolling tool history while preserving the recent tail', async () => {
    const compactor = new SessionCompactor({
      clock: (() => 1) as () => number,
      triggerTokensThreshold: 1,
      preserveRecentCount: 1,
      summarizer: async () => 'summary'
    });
    const messages = [
      { role: 'user' as const, content: 'old', timestamp: 1 },
      { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'tool call' }], timestamp: 2 },
      {
        role: 'toolResult' as const,
        toolCallId: '1',
        toolName: 'read',
        content: [{ type: 'text' as const, text: 'recent' }],
        timestamp: 3
      }
    ];
    const result = await compactor.compact(messages);
    expect(result.compactedMessages[0]).toMatchObject({ role: 'assistant', id: 'compaction_1' });
    expect(result.compactedMessages.at(-1)).toMatchObject({ role: 'toolResult', toolCallId: '1' });
  });
});
