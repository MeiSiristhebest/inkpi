import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AppendOnlySessionJournal,
  InkRepository
} from '@inkpi/storage';
import {
  Agent,
  reduceSession,
  detectAndMarkInterruptedOperations
} from '@inkpi/agent-core';
import type { AgentTool } from '@inkpi/protocol';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';

describe('Crash Recovery & Durable Event Sourcing E2E', () => {
  const tmpDir = path.resolve('.tmp-inkpi-crash-recovery');
  const journalFile = path.join(tmpDir, 'crash-test-journal.jsonl');
  const dbFile = path.join(tmpDir, 'crash-test.db');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    if (fs.existsSync(journalFile)) fs.unlinkSync(journalFile);
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should persist session turns, handle mid-operation crash, and resume with state consistency', async () => {
    const toolCallsMade: string[] = [];
    const lookupTool: AgentTool = {
      name: 'lookup_data',
      description: 'Lookup database facts',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' } }
      },
      execute: async (_id, args: any) => {
        toolCallsMade.push(args.query);
        return {
          content: [{ type: 'text', text: `Found facts for: ${args.query}` }],
          details: { count: 1 }
        };
      }
    };

    let streamTurn = 0;
    const deterministicStreamFn = () => {
      const stream = new AssistantEventStream();
      streamTurn++;
      if (streamTurn === 1) {
        // First turn: model requests a tool
        setTimeout(() => {
          stream.push({ type: 'text_delta', textDelta: 'Let me look up facts.' });
          stream.push({ type: 'tool_call_start', toolCallId: 'call_lookup_1', toolName: 'lookup_data' });
          stream.push({
            type: 'tool_call_end',
            toolCall: {
              type: 'toolCall',
              id: 'call_lookup_1',
              name: 'lookup_data',
              arguments: { query: 'creative assets' }
            }
          });
          stream.end();
        }, 10);
      } else {
        // Second turn: model answers with results
        setTimeout(() => {
          stream.push({ type: 'text_delta', textDelta: 'Summary based on looked up facts.' });
          stream.end();
        }, 10);
      }
      return stream;
    };

    // Phase 1: Initialize first Agent with persistent journal
    const journal1 = new AppendOnlySessionJournal({
      sessionId: 'sess_crash_demo',
      filePath: journalFile
    });

    const agent1 = new Agent({
      initialState: {
        model: getModelPreset('mock-test'),
        tools: [lookupTool]
      },
      journal: journal1,
      streamFn: deterministicStreamFn
    });

    await agent1.prompt('Please lookup creative assets');
    expect(agent1.state.messages.length).toBeGreaterThan(1);
    expect(toolCallsMade).toContain('creative assets');

    // Simulate mid-execution pending operation crash by appending an un-settled operation_intent
    journal1.append('operation_intent', {
      id: 'op_interrupted_stream',
      type: 'provider_stream',
      intent: { model: 'mock-test', tokenLimit: 1000 }
    });

    // Verify raw file exists on disk
    expect(fs.existsSync(journalFile)).toBe(true);
    const rawContent = fs.readFileSync(journalFile, 'utf8');
    expect(rawContent).toContain('sess_crash_demo');
    expect(rawContent).toContain('op_interrupted_stream');

    // Phase 2: Simulate process crash & reboot with a fresh Storage & Journal instance
    const journal2 = new AppendOnlySessionJournal({
      sessionId: 'sess_crash_demo',
      filePath: journalFile
    });

    const loadedEntries = journal2.getEntries();
    expect(loadedEntries.length).toBeGreaterThanOrEqual(4);

    // Reduce loaded entries to materialized session state
    const materializedState = reduceSession(loadedEntries);
    expect(materializedState.sessionId).toBe('sess_crash_demo');
    expect(materializedState.messages.length).toBeGreaterThan(0);
    expect(materializedState.messages[0].role).toBe('user');

    // Check hanging operation
    const op = materializedState.operations.get('op_interrupted_stream');
    expect(op?.state).toBe('running');

    // Run crash recovery detection (pure: input state must stay untouched)
    const recoveryResult = detectAndMarkInterruptedOperations(materializedState);
    expect(recoveryResult.recoveredCount).toBe(1);
    expect(recoveryResult.interruptedIds).toContain('op_interrupted_stream');
    expect(recoveryResult.state.operations.get('op_interrupted_stream')?.state).toBe('interrupted');
    expect(materializedState.operations.get('op_interrupted_stream')?.state).toBe('running');

    // Phase 3: Resume Agent from materialized state
    const resumeStreamFn = () => {
      const stream = new AssistantEventStream();
      setTimeout(() => {
        stream.push({ type: 'text_delta', textDelta: 'Resuming cleanly from journal recovery.' });
        stream.end();
      }, 10);
      return stream;
    };

    const resumedAgent = new Agent({
      initialState: {
        model: getModelPreset('mock-test'),
        messages: materializedState.messages,
        tools: [lookupTool]
      },
      journal: journal2,
      streamFn: resumeStreamFn
    });

    await resumedAgent.prompt('Continue next turn');
    const lastMsg = resumedAgent.state.messages[resumedAgent.state.messages.length - 1];
    expect(lastMsg.role).toBe('assistant');
    expect((lastMsg as any).content[0].text).toContain('Resuming cleanly');
  });
});
