import { AssistantEventStream } from '@inkpi/ai';
import type { TaskHandlerContext } from '@inkpi/agent-core';
import { RuntimeCacheCoordinator, ToolRegistry } from '@inkpi/agent-core';
import type { AiTask, ModelConfig } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { TaskModelHandler } from '@inkpi/server';

const model: ModelConfig = {
  id: 'cache-model',
  name: 'Cache model',
  provider: 'faux'
};

describe('Runtime provider response cache', () => {
  it('reuses successful final responses and invalidates older project revisions', async () => {
    const coordinator = new RuntimeCacheCoordinator();
    let streamCalls = 0;
    const handler = new TaskModelHandler({
      model,
      cacheCoordinator: coordinator,
      stream: () => {
        streamCalls += 1;
        return finalStream('cached answer');
      },
      defaultModelCapabilities: { outputFormats: ['text'], structuredOutput: true }
    });

    const first = await handler.execute(context({ id: 'first' }));
    const second = await handler.execute(context({ id: 'second' }));

    expect(first.output).toEqual({ format: 'text', text: 'cached answer' });
    expect(second.output).toEqual(first.output);
    expect(first.provenance).toMatchObject({ cacheHit: false, providerCacheHit: false });
    expect(second.provenance).toMatchObject({ cacheHit: true, providerCacheHit: true });
    expect(streamCalls).toBe(1);
    expect(handler.getProviderResponseCache().stats()).toMatchObject({ hits: 1, misses: 1 });
    expect(coordinator.stats().provider).toMatchObject({ hits: 1, misses: 1 });

    coordinator.invalidate({ reason: 'revision', projectRevision: 4 });
    await handler.execute(context({ id: 'after-revision', revision: 3 }));

    expect(streamCalls).toBe(2);
    expect(handler.getProviderResponseCache().stats()).toMatchObject({
      hits: 1,
      misses: 2,
      invalidations: 1
    });
  });

  it('does not cache a tool-call turn or its final follow-up response', async () => {
    const tools = new ToolRegistry();
    tools.register({
      name: 'lookup',
      description: 'Lookup',
      execute: async () => ({ content: [{ type: 'text', text: 'tool value' }] })
    });
    let streamCalls = 0;
    const handler = new TaskModelHandler({
      model,
      toolRegistry: tools,
      stream: () => {
        streamCalls += 1;
        if (streamCalls % 2 === 1) return toolCallStream();
        return finalStream('tool-backed answer');
      },
      defaultModelCapabilities: {
        outputFormats: ['text'],
        structuredOutput: true,
        tools: true,
        toolCalling: true
      }
    });

    await handler.execute(context({ id: 'tool-first' }));
    await handler.execute(context({ id: 'tool-second' }));

    expect(streamCalls).toBe(4);
    expect(handler.getProviderResponseCache().stats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it('does not cache invalid structured output', async () => {
    let streamCalls = 0;
    const handler = new TaskModelHandler({
      model,
      stream: () => {
        streamCalls += 1;
        return finalStream('not-json');
      },
      defaultModelCapabilities: { outputFormats: ['structured'], structuredOutput: true }
    });
    const taskContext = context({
      id: 'invalid-json',
      task: {
        id: 'invalid-json',
        kind: 'cache.structured',
        input: { text: 'same' },
        outputContract: { format: 'structured' }
      }
    });

    await expect(handler.execute(taskContext)).rejects.toThrow('not valid JSON');
    await expect(handler.execute(taskContext)).rejects.toThrow('not valid JSON');

    expect(streamCalls).toBe(2);
    expect(handler.getProviderResponseCache().stats()).toMatchObject({ hits: 0, misses: 2 });
  });

  it('does not retain thinking content in cache snapshots', async () => {
    const handler = new TaskModelHandler({
      model,
      stream: () => {
        const result = new AssistantEventStream();
        queueMicrotask(() => {
          result.push({ type: 'thinking_delta', thinkingDelta: 'private reasoning must not persist' });
          result.push({ type: 'text_delta', textDelta: '<think>hidden text</think>safe cached answer' });
          result.end();
        });
        return result;
      }
    });

    await handler.execute(context({ id: 'thinking-cache' }));
    const snapshot = handler.getProviderResponseCache().snapshot();

    expect(snapshot.entries[0]?.response.content).toEqual([{ type: 'text', text: 'safe cached answer' }]);
    expect(JSON.stringify(snapshot)).not.toContain('private reasoning must not persist');
  });
});

function context(options: {
  id: string;
  revision?: number;
  task?: AiTask;
}): TaskHandlerContext {
  const task = options.task ?? {
    id: options.id,
    kind: 'cache.text',
    input: {
      text: 'same input',
      selection: { documentId: 'document-1', from: 0, to: 4, revision: options.revision ?? 3 }
    },
    outputContract: { format: 'text' },
    metadata: { skillVersion: 'skill-1' }
  } satisfies AiTask;
  return {
    task,
    context: {
      fragments: [],
      text: 'same context',
      tokenEstimate: 3,
      fingerprint: 'context-fingerprint',
      truncated: false,
      projectRevision: options.revision ?? 3
    },
    instructions: {
      text: 'stable instruction',
      entryIds: ['instruction-1'],
      truncated: false,
      version: 'instructions-1'
    },
    signal: new AbortController().signal,
    executionRunId: `run:${options.id}`,
    attempt: 1,
    consumeSteering: () => [],
    saveCheckpoint: async () => undefined,
    reportProgress: () => undefined
  };
}

function finalStream(text: string): AssistantEventStream {
  const result = new AssistantEventStream();
  queueMicrotask(() => {
    result.push({ type: 'text_delta', textDelta: text });
    result.end();
  });
  return result;
}

function toolCallStream(): AssistantEventStream {
  const result = new AssistantEventStream();
  queueMicrotask(() => {
    result.push({ type: 'tool_call_start', toolCallId: 'call-1', toolName: 'lookup' });
    result.push({
      type: 'tool_call_end',
      toolCall: { type: 'toolCall', id: 'call-1', name: 'lookup', arguments: {} }
    });
    result.end();
  });
  return result;
}
