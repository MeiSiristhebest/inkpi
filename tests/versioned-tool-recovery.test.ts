import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Agent,
  ToolRegistry,
  detectAndMarkInterruptedOperations,
  planInterruptedRecovery,
  reduceSession
} from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import { type AgentTool, SessionCommitError, type ToolResultMessage } from '@inkpi/protocol';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';

function tool(overrides: Partial<AgentTool> = {}): AgentTool {
  return {
    name: 'chapter_read',
    description: 'Read a chapter',
    replay: 'safe',
    implementationVersion: '1',
    parameters: { type: 'object', required: ['chapter'], properties: { chapter: { type: 'string' } } },
    execute: async () => ({ content: [{ type: 'text', text: 'chapter facts' }] }),
    ...overrides
  };
}

function seed(journal: AppendOnlySessionJournal, original: AgentTool, change = ''): void {
  const registry = new ToolRegistry();
  registry.register(original);
  const contract = registry.getReplayContract(original.name)!;
  if (change === 'unknown-version') (contract as { version: number }).version = 2;
  journal.append('agent_turn', {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'provider-call', name: original.name, arguments: { chapter: 'one' } }],
    timestamp: 1
  });
  journal.append('operation_intent', {
    id: 'op_recovery',
    type: 'tool_call',
    invocationId: 'reserved-result',
    ...(change === 'legacy-policy' ? {} : { replay: change === 'historical-never' ? 'never' : 'safe' }),
    intent: {
      name: original.name,
      toolCallId: 'provider-call',
      sourceIndex: 0,
      arguments: { chapter: 'one' },
      ...(change === 'legacy-contract' ? {} : { contract })
    }
  });
}

function done(): AssistantEventStream {
  const stream = new AssistantEventStream();
  stream.push({ type: 'text_delta', textDelta: 'continued' });
  stream.end();
  return stream;
}

describe('versioned tool recovery', () => {
  it('replays through the actual Agent request path once, preserving the reserved identity across file restart', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkpi-tool-recovery-'));
    const file = path.join(dir, 'session.jsonl');
    const execute = vi.fn(tool().execute);
    const current = tool({ execute });
    try {
      seed(new AppendOnlySessionJournal({ sessionId: 'replay', filePath: file }), current);
      const restored = new AppendOnlySessionJournal({ sessionId: 'replay', filePath: file });
      const provider = vi.fn((_model, messages) => {
        expect(messages).toContainEqual(
          expect.objectContaining({
            role: 'toolResult',
            id: 'reserved-result',
            toolCallId: 'provider-call',
            isError: false
          })
        );
        return done();
      });
      const agent = new Agent({
        journal: restored,
        initialState: { model: getModelPreset('mock-test'), tools: [current] },
        streamFn: provider
      });
      await agent.prompt('continue');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(provider).toHaveBeenCalledTimes(1);
      expect(restored.getEntriesByType('tool_execution')).toHaveLength(1);
      expect(restored.getEntriesByType('tool_execution')[0].id).toBe('reserved-result');
      const restarted = new Agent({
        journal: new AppendOnlySessionJournal({ sessionId: 'replay', filePath: file }),
        initialState: { model: getModelPreset('mock-test'), tools: [current] },
        streamFn: () => done()
      });
      await restarted.prompt('next');
      expect(execute).toHaveBeenCalledTimes(1);
    } finally {
      if (fs.existsSync(file)) fs.unlinkSync(file);
      fs.rmdirSync(dir);
    }
  });

  it.each([
    'removed',
    'schema-changed',
    'implementation-changed',
    'current-never',
    'unversioned',
    'historical-never',
    'unknown-version',
    'permission-changed',
    'legacy-policy',
    'legacy-contract'
  ])('synthesizes an unknown result without effects for %s', async (change) => {
    const journal = new AppendOnlySessionJournal({ sessionId: `replay-${change}` });
    const execute = vi.fn(tool().execute);
    seed(journal, tool({ execute }), change);
    const current = tool({
      execute,
      ...(change === 'schema-changed' ? { parameters: { type: 'object', required: ['other'] } } : {}),
      ...(change === 'implementation-changed' ? { implementationVersion: '2' } : {}),
      ...(change === 'unversioned' ? { implementationVersion: undefined } : {}),
      ...(change === 'current-never' ? { replay: 'never' } : {})
    });
    const agent = new Agent({
      journal,
      initialState: { model: getModelPreset('mock-test'), tools: change === 'removed' ? [] : [current] },
      streamFn: () => done()
    });
    if (change === 'permission-changed')
      agent.getToolRegistry().register(current, { capabilities: ['different-capability'] });
    await agent.prompt('continue');
    expect(execute).not.toHaveBeenCalled();
    const result = agent.state.messages.find((message) => message.role === 'toolResult') as ToolResultMessage;
    expect(result).toMatchObject({ id: 'reserved-result', toolCallId: 'provider-call', isError: true });
    expect(result.content).toContainEqual({ type: 'text', text: expect.stringContaining('result is unknown') });
    await agent.recoverInterruptedTools();
    expect(journal.getEntriesByType('tool_execution')).toHaveLength(1);
  });

  it.each(['gate', 'registration'])('rechecks %s before a recovered effect', async (change) => {
    const execute = vi.fn(tool().execute);
    const current = tool({ execute });
    const journal = new AppendOnlySessionJournal({ sessionId: `gate-${change}` });
    seed(journal, current);
    const agent: Agent = new Agent({
      journal,
      initialState: { model: getModelPreset('mock-test'), tools: [current] },
      streamFn: () => done(),
      beforeToolCall: async () => {
        if (change === 'registration') {
          agent.getToolRegistry().register(tool({ execute, replay: 'never' }));
          return undefined;
        }
        return { block: true, reason: 'current permission denied' };
      }
    });
    await agent.prompt('continue');
    expect(execute).not.toHaveBeenCalled();
    expect(agent.state.messages.find((message) => message.role === 'toolResult')).toMatchObject({ isError: true });
  });

  it('does not repeat a persisted result when its old settlement record is absent', async () => {
    const execute = vi.fn(tool().execute);
    const current = tool({ execute });
    const journal = new AppendOnlySessionJournal({ sessionId: 'legacy-result' });
    seed(journal, current);
    journal.append(
      'tool_execution',
      {
        role: 'toolResult',
        toolCallId: 'provider-call',
        toolName: current.name,
        content: [{ type: 'text', text: 'already saved' }],
        timestamp: 1
      },
      'reserved-result'
    );
    const registry = new ToolRegistry();
    registry.register(current);
    const recovered = detectAndMarkInterruptedOperations(reduceSession(journal.getEntries()), () => 2);
    expect(planInterruptedRecovery(recovered.state, registry)).toEqual([]);
    expect(recovered.state.operations.get('op_recovery')?.state).toBe('settled');
    await new Agent({
      journal,
      initialState: { model: getModelPreset('mock-test'), tools: [current] },
      streamFn: () => done()
    }).prompt('continue');
    expect(execute).not.toHaveBeenCalled();
    expect(journal.getEntriesByType('tool_execution')).toHaveLength(1);
  });

  it('reconstructs an uncertain settlement without repeating an already committed effect', async () => {
    const execute = vi.fn(tool().execute);
    const current = tool({ execute });
    const journal = new AppendOnlySessionJournal({ sessionId: 'uncertain-recovery' });
    seed(journal, current);
    const writer = {
      getEntries: () => journal.getEntries(),
      append: journal.append.bind(journal),
      appendBatch: (batch: Parameters<AppendOnlySessionJournal['appendBatch']>[0]) => {
        const result = journal.appendBatch(batch);
        if (batch.some((entry) => entry.type === 'operation_settlement'))
          throw new SessionCommitError('settlement acknowledgement lost', 'unknown');
        return result;
      }
    };
    const agent = new Agent({
      journal: writer,
      initialState: { model: getModelPreset('mock-test'), tools: [current] }
    });
    await expect(agent.recoverInterruptedTools()).rejects.toThrow('acknowledgement lost');
    expect(agent.state.isFaulted).toBe(true);
    await expect(agent.continue()).rejects.toThrow('Reconstruct');
    const restarted = new Agent({
      journal,
      initialState: { model: getModelPreset('mock-test'), tools: [current] },
      streamFn: () => done()
    });
    await restarted.prompt('continue');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(journal.getEntriesByType('tool_execution')).toHaveLength(1);
  });

  it('keeps reused provider call ids separate across turns', async () => {
    const journal = new AppendOnlySessionJournal({ sessionId: 'reused-provider-id' });
    let requests = 0;
    const execute = vi.fn(tool().execute);
    const agent = new Agent({
      journal,
      initialState: { model: getModelPreset('mock-test'), tools: [tool({ execute })] },
      streamFn: () => {
        if (++requests % 2 === 0) return done();
        const stream = new AssistantEventStream();
        stream.push({ type: 'tool_call_start', toolCallId: 'same', toolName: 'chapter_read' });
        stream.push({
          type: 'tool_call_end',
          toolCall: { type: 'toolCall', id: 'same', name: 'chapter_read', arguments: { chapter: 'one' } }
        });
        stream.end();
        return stream;
      }
    });
    await agent.prompt('first');
    await agent.prompt('second');
    const operations = reduceSession(journal.getEntries()).operations;
    const tools = [...operations.values()].filter((operation) => operation.type === 'tool_call');
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((operation) => operation.id)).size).toBe(2);
    expect(tools.every((operation) => operation.state === 'settled')).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('aborts recovery and drains its handler before allowing the Agent to become idle', async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const current = tool({
      execute: async (_id, _params, signal) => {
        started();
        await new Promise<void>((resolve) => signal!.addEventListener('abort', () => resolve(), { once: true }));
        throw new DOMException('recovery cancelled', 'AbortError');
      }
    });
    const journal = new AppendOnlySessionJournal({ sessionId: 'cancel-recovery' });
    seed(journal, current);
    const provider = vi.fn(() => done());
    const agent = new Agent({
      journal,
      initialState: { model: getModelPreset('mock-test'), tools: [current] },
      streamFn: provider
    });
    const request = agent.prompt('continue');
    await running;
    expect(agent.isIdle).toBe(false);
    const abort = agent.abort();
    await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await abort;
    expect(agent.isIdle).toBe(true);
    expect(provider).not.toHaveBeenCalled();
    expect(journal.getEntriesByType('tool_execution')).toHaveLength(1);
    expect(journal.getEntriesByType('tool_execution')[0].payload.isError).toBe(true);
  });

  it('rejects ambiguous invocation identities before performing a recovered effect', async () => {
    const execute = vi.fn(tool().execute);
    const current = tool({ execute });
    const journal = new AppendOnlySessionJournal({ sessionId: 'ambiguous-recovery' });
    seed(journal, current);
    const intent = structuredClone(journal.getEntriesByType('operation_intent')[0].payload);
    journal.append('operation_intent', { ...intent, id: 'second-operation' });
    const agent = new Agent({ journal, initialState: { model: getModelPreset('mock-test'), tools: [current] } });
    await expect(agent.recoverInterruptedTools()).rejects.toThrow('Ambiguous');
    expect(execute).not.toHaveBeenCalled();
    expect(journal.getEntriesByType('tool_execution')).toHaveLength(0);
  });
});
