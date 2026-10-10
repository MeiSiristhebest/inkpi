import { Agent, createCodemodeTool } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import type { AgentTool } from '@inkpi/protocol';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

function answer(text = 'done'): AssistantEventStream {
  const stream = new AssistantEventStream();
  stream.push({ type: 'text_delta', textDelta: text });
  stream.end();
  return stream;
}

function codemodeCall(code: string): AssistantEventStream {
  const stream = new AssistantEventStream();
  const id = 'codemode-call';
  stream.push({ type: 'tool_call_start', toolCallId: id, toolName: 'codemode' });
  stream.push({ type: 'tool_call_delta', toolCallId: id, argsDelta: JSON.stringify({ code }) });
  stream.push({
    type: 'tool_call_end',
    toolCall: { type: 'toolCall', id, name: 'codemode', arguments: { code } }
  });
  stream.end();
  return stream;
}

function agentForCode(code: string, options: ConstructorParameters<typeof Agent>[0] = {}): Agent {
  let requestCount = 0;
  return new Agent({
    ...options,
    initialState: { model: getModelPreset('mock-test') },
    streamFn: () => (requestCount++ === 0 ? codemodeCall(code) : answer())
  });
}

function codeModeTool(
  allowedReadTools: string[],
  options: { timeoutMs?: number; memoryLimitBytes?: number; maxOutputChars?: number } = {}
) {
  return createCodemodeTool({ allowedReadTools, ...options });
}

describe('CodeMode Agent tool', () => {
  it('routes nested reads through policy and journal without adding their results to conversation history', async () => {
    const journal = new AppendOnlySessionJournal('codemode-hidden-results');
    const hooks: string[] = [];
    const nestedStarts: string[] = [];
    const nestedEnds: string[] = [];
    let reads = 0;
    const agent = agentForCode(
      `const row = await tools.lookup({ query: "chapter" });
       text("matches=" + row.details.count);
       return { count: row.details.count };`,
      {
        journal,
        beforeToolCall: async ({ toolCall }) => {
          hooks.push(`before:${toolCall.name}`);
          return undefined;
        },
        afterToolCall: async ({ toolCall }) => {
          hooks.push(`after:${toolCall.name}`);
          return undefined;
        }
      }
    );
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'tool_execution_start' && event.toolName === 'lookup') {
        nestedStarts.push(event.toolCallId);
      } else if (event.type === 'tool_execution_end' && event.toolCallId.startsWith('codemode_')) {
        nestedEnds.push(event.toolCallId);
      }
    });
    const lookup: AgentTool = {
      name: 'lookup',
      description: 'Read chapter records',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
        additionalProperties: false
      },
      replay: 'safe',
      execute: async () => {
        reads += 1;
        return {
          content: [{ type: 'text', text: 'private-record' }],
          details: { count: 1, record: 'private-record' }
        };
      }
    };
    agent.getToolRegistry().register(lookup, { source: 'trusted-read', capabilities: ['read'] });
    agent.getToolRegistry().register(codeModeTool(['lookup']), { source: 'runtime', capabilities: ['compute'] });

    await agent.prompt('Summarize the chapter records.');
    unsubscribe();

    const history = JSON.stringify(agent.state.messages);
    expect(reads).toBe(1);
    expect(hooks).toContain('before:lookup');
    expect(hooks).toContain('after:lookup');
    expect(nestedStarts).toHaveLength(1);
    expect(nestedEnds).toEqual(nestedStarts);
    expect(history).toContain('matches=1');
    expect(agent.state.messages.find((message) => message.role === 'toolResult')?.content).toContainEqual({
      type: 'text',
      text: 'Return value: {"count":1}'
    });
    expect(history).not.toContain('private-record');

    const entries = journal.getEntries();
    const nestedIntent = entries.find(
      (entry) => entry.type === 'operation_intent' && entry.payload?.type === 'codemode_read'
    );
    expect(nestedIntent?.payload?.intent).toMatchObject({
      name: 'lookup',
      visibility: 'internal',
      parentToolCallId: 'codemode-call'
    });
    expect(
      entries.some((entry) => entry.type === 'operation_settlement' && entry.payload?.type === 'codemode_read')
    ).toBe(true);
    expect(
      entries.filter((entry) => entry.type === 'tool_execution').some((entry) => entry.payload?.toolName === 'lookup')
    ).toBe(false);
  });

  it('does not expose tools whose registration contains a non-read capability', async () => {
    let writes = 0;
    const agent = agentForCode(
      `const listed = ALL_TOOLS.some((tool) => tool.name === "unsafe");
       let rejected = false;
       try { await tools.unsafe({}); } catch { rejected = true; }
       text(JSON.stringify({ listed, rejected }));`,
      {}
    );
    agent.getToolRegistry().register(
      {
        name: 'unsafe',
        description: 'Read and mutate records',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          writes += 1;
          return { content: [{ type: 'text', text: 'unexpected' }] };
        }
      },
      { source: 'mixed-capability', capabilities: ['read', 'write'] }
    );
    agent.getToolRegistry().register(codeModeTool(['unsafe']), { source: 'runtime', capabilities: ['compute'] });

    await agent.prompt('Try to use the unsafe tool from a script.');

    expect(writes).toBe(0);
    expect(
      agent.state.messages
        .find((message) => message.role === 'toolResult')
        ?.content.some((item) => item.type === 'text' && item.text === '{"listed":false,"rejected":true}')
    ).toBe(true);
  });

  it('enforces a bounded script output before publishing the result', async () => {
    const agent = agentForCode(`text("x".repeat(65537)); return "done";`);
    agent.getToolRegistry().register(codeModeTool([]), { source: 'runtime', capabilities: ['compute'] });

    await agent.prompt('Run the output limit check.');

    const toolResult = agent.state.messages.find((message) => message.role === 'toolResult');
    expect(toolResult).toMatchObject({ isError: true });
    expect(JSON.stringify(toolResult)).toContain('output exceeds 65536 characters');
  });

  it('limits nested read calls to 32 per script', async () => {
    let reads = 0;
    const agent = agentForCode('for (let i = 0; i < 33; i++) await tools.lookup({});');
    agent.getToolRegistry().register(
      {
        name: 'lookup',
        description: 'Read records',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        replay: 'safe',
        execute: async () => {
          reads += 1;
          return { content: [] };
        }
      },
      { source: 'trusted-read', capabilities: ['read'] }
    );
    agent.getToolRegistry().register(codeModeTool(['lookup']), { source: 'runtime', capabilities: ['compute'] });

    await agent.prompt('Check the nested-call limit.');

    expect(reads).toBe(32);
    const result = agent.state.messages.find((message) => message.role === 'toolResult');
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('at most 32 nested calls');
  });

  it('bounds nested read results before exposing them to a script', async () => {
    const agent = agentForCode('return await tools.lookup({});');
    agent.getToolRegistry().register(
      {
        name: 'lookup',
        description: 'Read a large record',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        replay: 'safe',
        execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(32 * 1024 + 1) }] })
      },
      { source: 'trusted-read', capabilities: ['read'] }
    );
    agent.getToolRegistry().register(codeModeTool(['lookup']), { source: 'runtime', capabilities: ['compute'] });

    await agent.prompt('Check the nested-result limit.');

    const result = agent.state.messages.find((message) => message.role === 'toolResult');
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain('Nested tool result exceeds 32768 bytes');
    expect(JSON.stringify(result)).not.toContain('x'.repeat(100));
  });
});

describe('CodeMode worker limits through Agent', () => {
  async function runCode(code: string, options: { timeoutMs?: number; memoryLimitBytes?: number } = {}) {
    const agent = agentForCode(code);
    agent.getToolRegistry().register(codeModeTool([], options), { source: 'runtime', capabilities: ['compute'] });
    await agent.prompt('Run the CodeMode script.');
    return agent.state.messages.find((message) => message.role === 'toolResult');
  }

  it('does not expose host globals to an untrusted script', async () => {
    const result = await runCode(
      'return { process: typeof process, require: typeof require, fetch: typeof fetch, timers: typeof setTimeout };'
    );
    expect(result?.content).toContainEqual({
      type: 'text',
      text: 'Return value: {"process":"undefined","require":"undefined","fetch":"undefined","timers":"undefined"}'
    });
  });

  it('interrupts infinite loops at the configured time limit', async () => {
    const result = await runCode('while (true) {}', { timeoutMs: 500 });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toMatch(/timeout|time limit/i);
  });

  it('enforces the configured QuickJS memory limit', async () => {
    const result = await runCode('const values = []; while (true) values.push("x".repeat(65536));', {
      timeoutMs: 5000,
      memoryLimitBytes: 4 * 1024 * 1024
    });
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toMatch(/memory|alloc|out of memory/i);
  });

  it('cancels a running worker through Agent.abort()', async () => {
    const agent = agentForCode('while (true) {}');
    agent.getToolRegistry().register(codeModeTool([], { timeoutMs: 10_000 }), {
      source: 'runtime',
      capabilities: ['compute']
    });
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let sawStart = false;
    const unsubscribe = agent.subscribe((event) => {
      if (event.type === 'tool_execution_start' && event.toolName === 'codemode' && !sawStart) {
        sawStart = true;
        notifyStarted();
      }
    });

    const run = agent.prompt('Run the cancellable script.');
    await started;
    const abort = agent.abort();
    await Promise.all([run, abort]);
    unsubscribe();

    const result = agent.state.messages.find((message) => message.role === 'toolResult');
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toMatch(/abort|cancel/i);
  });
});
