import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Agent, createCodemodeTool } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import type { AgentTool } from '@inkpi/protocol';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { describe, expect, it, vi } from 'vitest';
import {
  acquireCodemodeWorkerSlot,
  getCodemodeWorkerAdmissionSnapshot
} from '../packages/agent-core/src/codemode-admission.js';
import {
  getActiveCodemodeWorkerCount,
  trackCodemodeWorkerExit
} from '../packages/agent-core/src/codemode-worker-lifecycle.js';

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
  options: { timeoutMs?: number; memoryLimitBytes?: number; maxOutputChars?: number; workerUrl?: string | URL } = {}
) {
  return createCodemodeTool({ allowedReadTools, ...options });
}

async function waitForActiveWorkerCount(expected: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (getActiveCodemodeWorkerCount() !== expected) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for ${expected} active Codemode workers; currently ${getActiveCodemodeWorkerCount()}.`
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

async function waitForAdmissionSnapshot(activeSlots: number, queuedRequests: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const snapshot = getCodemodeWorkerAdmissionSnapshot();
    if (snapshot.activeSlots === activeSlots && snapshot.queuedRequests === queuedRequests) return;
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for Codemode admission ${activeSlots}/${queuedRequests}; got ${snapshot.activeSlots}/${snapshot.queuedRequests}.`
      );
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createBlockedReadAgent(onRead?: () => void) {
  const started = deferred<void>();
  const resume = deferred<void>();
  const agent = agentForCode('await tools.wait({}); return "done";');
  agent.getToolRegistry().register(
    {
      name: 'wait',
      description: 'Wait for the integration test to release this read.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      replay: 'safe',
      execute: async () => {
        onRead?.();
        started.resolve();
        await resume.promise;
        return { content: [] };
      }
    },
    { source: 'test-read', capabilities: ['read'] }
  );
  agent.getToolRegistry().register(codeModeTool(['wait']), { source: 'runtime', capabilities: ['compute'] });
  return { agent, started: started.promise, release: () => resume.resolve() };
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

  it('queues nested reads beyond four concurrent calls instead of rejecting them', async () => {
    let activeReads = 0;
    let maxActiveReads = 0;
    let readCount = 0;
    const agent = agentForCode(
      'const rows = await Promise.all(Array.from({ length: 8 }, () => tools.lookup({}))); return rows.length;'
    );
    agent.getToolRegistry().register(
      {
        name: 'lookup',
        description: 'Read a record.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        replay: 'safe',
        execute: async () => {
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          readCount += 1;
          try {
            await new Promise<void>((resolve) => setTimeout(resolve, 15));
            return { content: [] };
          } finally {
            activeReads -= 1;
          }
        }
      },
      { source: 'test-read', capabilities: ['read'] }
    );
    agent.getToolRegistry().register(codeModeTool(['lookup']), { source: 'runtime', capabilities: ['compute'] });

    await agent.prompt('Check nested-call backpressure.');

    const result = agent.state.messages.find((message) => message.role === 'toolResult');
    expect(result).toMatchObject({ isError: false });
    expect(result?.content).toContainEqual({ type: 'text', text: 'Return value: 8' });
    expect(readCount).toBe(8);
    expect(maxActiveReads).toBe(4);
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
  async function runCode(
    code: string,
    options: { timeoutMs?: number; memoryLimitBytes?: number; workerUrl?: string | URL } = {}
  ) {
    const agent = agentForCode(code);
    agent.getToolRegistry().register(codeModeTool([], options), { source: 'runtime', capabilities: ['compute'] });
    await agent.prompt('Run the CodeMode script.');
    return agent.state.messages.find((message) => message.role === 'toolResult');
  }

  it('counts worker-admission wait against the script deadline', async () => {
    await waitForAdmissionSnapshot(0, 0);
    const releaseFirst = await acquireCodemodeWorkerSlot(undefined, 1_000);
    const releaseSecond = await acquireCodemodeWorkerSlot(undefined, 1_000);
    const agent = agentForCode('text("must not run"); return 1;');
    agent
      .getToolRegistry()
      .register(codeModeTool([], { timeoutMs: 750 }), { source: 'runtime', capabilities: ['compute'] });
    try {
      const run = agent.prompt('Check the worker admission deadline.');
      await waitForAdmissionSnapshot(2, 1);
      await run;

      const result = agent.state.messages.find((message) => message.role === 'toolResult');
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toMatch(/Codemode worker admission wait timed out/);
      expect(JSON.stringify(result)).not.toContain('must not run');
      expect(getCodemodeWorkerAdmissionSnapshot()).toMatchObject({ activeSlots: 2, queuedRequests: 0 });
    } finally {
      releaseFirst();
      releaseSecond();
      await waitForAdmissionSnapshot(0, 0);
    }
  });

  it('limits workers across agents and cancels a queued session without stopping running sessions', async () => {
    await waitForActiveWorkerCount(0);
    await waitForAdmissionSnapshot(0, 0);
    const first = createBlockedReadAgent();
    const second = createBlockedReadAgent();
    let thirdReadStarted = false;
    const third = createBlockedReadAgent(() => {
      thirdReadStarted = true;
    });
    const firstRun = first.agent.prompt('Run session one.');
    const secondRun = second.agent.prompt('Run session two.');
    let thirdRun: Promise<void> | undefined;

    try {
      await Promise.all([first.started, second.started]);
      await waitForActiveWorkerCount(2);
      expect(getCodemodeWorkerAdmissionSnapshot()).toMatchObject({ activeSlots: 2, queuedRequests: 0 });

      thirdRun = third.agent.prompt('Run session three.');
      await waitForAdmissionSnapshot(2, 1);
      expect(getActiveCodemodeWorkerCount()).toBe(2);

      const abortThird = third.agent.abort();
      await Promise.all([thirdRun, abortThird]);
      await waitForAdmissionSnapshot(2, 0);
      expect(thirdReadStarted).toBe(false);
      expect(getActiveCodemodeWorkerCount()).toBe(2);

      first.release();
      second.release();
      await Promise.all([firstRun, secondRun]);
      await waitForActiveWorkerCount(0);
      await waitForAdmissionSnapshot(0, 0);
    } finally {
      if (thirdRun) await third.agent.abort();
      first.release();
      second.release();
      third.release();
      await Promise.allSettled([firstRun, secondRun, ...(thirdRun ? [thirdRun] : [])]);
      await waitForActiveWorkerCount(0);
      await waitForAdmissionSnapshot(0, 0);
    }
  });

  it('releases an admitted slot when QuickJS WASM loading fails before worker startup', async () => {
    await waitForAdmissionSnapshot(0, 0);
    const releaseHeldSlot = await acquireCodemodeWorkerSlot(undefined, 1_000);
    vi.stubGlobal('Bun', {
      embeddedFiles: [
        {
          name: 'quickjs-test.wasm',
          type: 'application/wasm',
          arrayBuffer: async () => new ArrayBuffer(8)
        }
      ]
    });
    vi.stubGlobal('WebAssembly', {
      compile: async () => {
        throw new Error('simulated QuickJS WASM compile failure');
      }
    });
    const agent = agentForCode('return "not started";');
    agent.getToolRegistry().register(codeModeTool([], { timeoutMs: 2_000 }), {
      source: 'runtime',
      capabilities: ['compute']
    });

    try {
      await agent.prompt('Check WASM-load cleanup.');
      const result = agent.state.messages.find((message) => message.role === 'toolResult');
      expect(result).toMatchObject({ isError: true });
      expect(JSON.stringify(result)).toMatch(/QuickJS|WASM/i);
      expect(getActiveCodemodeWorkerCount()).toBe(0);
      expect(getCodemodeWorkerAdmissionSnapshot()).toMatchObject({ activeSlots: 1, queuedRequests: 0 });
    } finally {
      vi.unstubAllGlobals();
      releaseHeldSlot();
      await waitForAdmissionSnapshot(0, 0);
    }
  });

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
    await waitForActiveWorkerCount(0);
    const activeBefore = getActiveCodemodeWorkerCount();
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
    await waitForActiveWorkerCount(activeBefore + 1);
    const abort = agent.abort();
    await Promise.all([run, abort]);
    unsubscribe();
    await waitForActiveWorkerCount(activeBefore);

    const result = agent.state.messages.find((message) => message.role === 'toolResult');
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toMatch(/abort|cancel/i);
  });

  it('tracks workers until their actual exit notification settles', async () => {
    const activeBefore = getActiveCodemodeWorkerCount();
    let notifyExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      notifyExit = resolve;
    });

    trackCodemodeWorkerExit(exited);
    expect(getActiveCodemodeWorkerCount()).toBe(activeBefore + 1);
    notifyExit();
    await waitForActiveWorkerCount(activeBefore);
  });

  it('cleans up worker tracking after startup failure', async () => {
    await waitForActiveWorkerCount(0);
    const activeBefore = getActiveCodemodeWorkerCount();
    const workerUrl = pathToFileURL(join(tmpdir(), `inkpi-missing-codemode-worker-${randomUUID()}.mjs`));
    const result = await runCode('return "unreachable";', { workerUrl });

    expect(result).toMatchObject({ isError: true });
    await waitForActiveWorkerCount(activeBefore);
    await waitForAdmissionSnapshot(0, 0);
  });

  it('cleans up repeated sequential and parallel worker runs', async () => {
    await waitForActiveWorkerCount(0);
    const activeBefore = getActiveCodemodeWorkerCount();
    for (const value of [1, 2]) {
      const result = await runCode(`return ${value};`);
      expect(result).toMatchObject({ isError: false });
      await waitForActiveWorkerCount(activeBefore);
    }

    const parallelResults = await Promise.all([3, 4, 5, 6].map((value) => runCode(`return ${value};`)));
    expect(parallelResults).toHaveLength(4);
    for (const result of parallelResults) expect(result).toMatchObject({ isError: false });
    await waitForActiveWorkerCount(activeBefore);
  });
});
