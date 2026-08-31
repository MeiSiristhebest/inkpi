import { describe, it, expect } from 'vitest';
import {
  Agent,
  ToolRegistry,
  SteeringQueue,
  FollowUpQueue,
  SessionTree,
  ExtensionHost,
  ExtensionRunner
} from '@inkpi/agent-core';
import type { AgentTool, AgentEvent, AgentMessage, UserMessage } from '@inkpi/protocol';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';

describe('@inkpi/agent-core', () => {
  it('should manage MessageQueues with different queue modes', () => {
    const queue = new SteeringQueue();
    const msg1: AgentMessage = { role: 'user', content: '纠偏1' };
    const msg2: AgentMessage = { role: 'user', content: '纠偏2' };

    queue.enqueue(msg1, msg2);
    expect(queue.size()).toBe(2);
    expect(queue.peek()).toBe(msg1);
    expect(queue.toArray().length).toBe(2);

    const one = queue.drain('one-at-a-time');
    expect(one.length).toBe(1);
    expect(one[0]).toBe(msg1);
    expect(queue.size()).toBe(1);

    const rest = queue.drain('all');
    expect(rest.length).toBe(1);
    expect(rest[0]).toBe(msg2);
    expect(queue.size()).toBe(0);

    queue.enqueue(msg1);
    queue.clear();
    expect(queue.size()).toBe(0);
  });

  it('should validate and execute tools with ToolRegistry', async () => {
    const registry = new ToolRegistry();
    const mockTool: AgentTool<{ query: string }> = {
      name: 'test_tool',
      description: '测试工具',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' } }
      },
      execute: async (_callId, params) => {
        return {
          content: [{ type: 'text', text: `查询结果: ${params.query}` }],
          details: { query: params.query }
        };
      }
    };

    registry.register(mockTool);
    expect(registry.get('test_tool')).toBe(mockTool);
    expect(registry.getAll().length).toBe(1);

    // Missing param test
    const failRes = await registry.executeTool({
      type: 'toolCall',
      id: 'c1',
      name: 'test_tool',
      arguments: {}
    });
    expect(failRes.isError).toBe(true);

    // Unregistered tool test
    const notFoundRes = await registry.executeTool({
      type: 'toolCall',
      id: 'c_none',
      name: 'non_existent',
      arguments: {}
    });
    expect(notFoundRes.isError).toBe(true);

    // Aborted signal tool test
    const ac = new AbortController();
    ac.abort();
    const abortRes = await registry.executeTool({
      type: 'toolCall',
      id: 'c_abort',
      name: 'test_tool',
      arguments: { query: 'test' }
    }, ac.signal);
    expect(abortRes.isError).toBe(true);

    // Success test
    const successRes = await registry.executeTool({
      type: 'toolCall',
      id: 'c2',
      name: 'test_tool',
      arguments: { query: '太虚道宗' }
    });
    expect(successRes.isError).toBe(false);
    expect(successRes.content[0]).toEqual({ type: 'text', text: '查询结果: 太虚道宗' });

    // Batch sequential and parallel
    const batch = await registry.executeBatch([
      { type: 'toolCall', id: 'b1', name: 'test_tool', arguments: { query: '1' } },
      { type: 'toolCall', id: 'b2', name: 'test_tool', arguments: { query: '2' } }
    ], 'sequential');
    expect(batch.length).toBe(2);

    expect(registry.unregister('test_tool')).toBe(true);
    expect(registry.get('test_tool')).toBeUndefined();
  });

  it('should manage branching and DAG history with SessionTree', () => {
    let nextId = 0;
    const tree = new SessionTree([], {
      idGenerator: () => `generated_${++nextId}`,
      clock: () => 1234
    });
    const msg1: AgentMessage = { id: 'm1', role: 'user', content: '第一幕' };
    const msg2: AgentMessage = { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '主角拔剑' }] };

    tree.addMessage(msg1);
    tree.addMessage(msg2);

    expect(tree.size()).toBe(2);
    expect(tree.getCurrentLeafId()).toBe('m2');
    expect(tree.getNode('m1')?.message).toEqual(msg1);
    expect(tree.getHistory().length).toBe(2);

    // Fork from m1
    tree.fork('m1');
    const msg3: AgentMessage = { id: 'm3', role: 'assistant', content: [{ type: 'text', text: '主角转身离去' }] };
    tree.addMessage(msg3);

    const historyBranch2 = tree.getHistory();
    expect(historyBranch2.length).toBe(2);
    expect(historyBranch2[1].id).toBe('m3');

    // Navigation test
    expect(tree.navigate('m2')).toBe(true);
    expect(tree.getCurrentLeafId()).toBe('m2');
    expect(tree.navigate('non_existing')).toBe(false);

    expect(tree.getBranches().length).toBe(2);

    expect(() => tree.addMessage({ id: 'm2', role: 'assistant', content: [] })).toThrow('already exists');
    expect(() => tree.addMessage({ role: 'user', content: 'orphan' }, 'missing')).toThrow('Parent node');
    expect(() => tree.branch()).toThrow('requires a non-empty label');

    tree.clear();
    expect(tree.size()).toBe(0);
  });

  it('should generate stable unique IDs and valid branch marker messages', () => {
    let nextId = 0;
    const tree = new SessionTree([], { idGenerator: () => `generated_${++nextId}` });
    const rootId = tree.addMessage({ role: 'user', content: 'root' });
    expect(rootId).toBe('generated_1');

    expect(() => tree.addMessage({ id: rootId, role: 'assistant', content: [] })).toThrow('already exists');

    const branchNode = tree.branch('alternate', 'test premise');
    expect(branchNode.message).toMatchObject({
      role: 'custom',
      customType: 'branch',
      content: { label: 'alternate', hypothesis: 'test premise' }
    });
    expect(tree.getHistory()).toHaveLength(2);
  });

  it('should run full Agent prompt, continue, steer, followUp, and lifecycle', async () => {
    const agent = new Agent({
      initialState: {
        model: getModelPreset('mock-test')
      },
      afterToolCall: async ({ result }) => {
        return { content: result.content, details: { intercepted: true } };
      }
    });

    const events: AgentEvent[] = [];
    const unsubscribe = agent.subscribe((ev) => {
      events.push(ev);
    });

    // Prompt
    await agent.prompt('写一段决战序document');
    expect(events.some((e) => e.type === 'agent_start')).toBe(true);
    expect(events.some((e) => e.type === 'agent_end')).toBe(true);

    // Steer & Continue
    agent.steer({ role: 'user', content: '注意加入雨景描写' });
    await agent.continue();
    expect(agent.state.messages.length).toBeGreaterThan(2);

    // FollowUp
    agent.followUp({ role: 'user', content: '总结本document战局' });
    await agent.continue();
    expect(agent.state.messages.length).toBeGreaterThan(3);

    // Wait for idle & reset
    await agent.waitForIdle();
    agent.reset();
    expect(agent.state.messages.length).toBe(0);

    unsubscribe();
  });

  it('should reject a second run while the first run is still streaming', async () => {
    let releaseStream!: () => void;
    let markStarted!: () => void;
    const streamStarted = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const streamRelease = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });

    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      streamFn: () => {
        markStarted();
        const stream = new AssistantEventStream();
        void streamRelease.then(() => {
          stream.push({ type: 'text_delta', textDelta: 'completed' });
          stream.end();
        });
        return stream;
      }
    });

    const firstRun = agent.prompt('first');
    await streamStarted;

    await expect(agent.prompt('second')).rejects.toThrow('run in progress');
    expect(() => agent.reset()).toThrow('already processing');
    expect(agent.state.messages.filter((message) => message.role === 'user')).toHaveLength(1);

    releaseStream();
    await firstRun;
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'completed' }]
    });

    await agent.continue();
  });

  it('should settle asynchronous stream listeners before message_end', async () => {
    let releaseListener!: () => void;
    let markListenerStarted!: () => void;
    const listenerReleased = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    const listenerStarted = new Promise<void>((resolve) => {
      markListenerStarted = resolve;
    });
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      streamFn: () => {
        const stream = new AssistantEventStream();
        queueMicrotask(() => {
          stream.push({ type: 'text_delta', textDelta: 'ordered' });
          stream.end();
        });
        return stream;
      }
    });
    const events: string[] = [];
    agent.subscribe(async (event) => {
      if (event.type === 'message_update') {
        markListenerStarted();
        await listenerReleased;
        events.push('update-settled');
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        events.push('message-end');
      }
    });

    const run = agent.prompt('order');
    await listenerStarted;
    expect(events).toEqual([]);
    releaseListener();
    await run;
    expect(events).toEqual(['update-settled', 'message-end']);
  });

  it('should preserve provider errors and clean transient state after stream failure', async () => {
    const streamFailure = new Error('collect failed');
    const failingAgent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      streamFn: () => ({
        on: () => () => undefined,
        waitForListeners: async () => undefined,
        collect: async () => { throw streamFailure; },
        abort: () => undefined,
        [Symbol.asyncIterator]: async function* () { /* no events */ }
      })
    });

    await expect(failingAgent.prompt('fail')).rejects.toThrow('collect failed');
    expect(failingAgent.state.errorMessage).toBe('collect failed');
    expect(failingAgent.state.isStreaming).toBe(false);
    expect(failingAgent.state.streamingMessage).toBeUndefined();
    expect(failingAgent.state.pendingToolCalls.size).toBe(0);

    const errorMessageAgent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      streamFn: () => {
        const stream = new AssistantEventStream();
        stream.error('provider failed');
        return stream;
      }
    });
    await errorMessageAgent.prompt('provider error');
    expect(errorMessageAgent.state.errorMessage).toBe('provider failed');
    expect(errorMessageAgent.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'provider failed'
    });
  });

  it('should allow a new prompt after aborting an active run', async () => {
    let callCount = 0;
    let streamStarted!: () => void;
    const streamStartedPromise = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      streamFn: (_model, _messages, options) => {
        callCount += 1;
        const stream = new AssistantEventStream();
        if (callCount === 1) {
          streamStarted();
          options?.signal?.addEventListener('abort', () => stream.abort(), { once: true });
        } else {
          stream.push({ type: 'text_delta', textDelta: 'second run' });
          stream.end();
        }
        return stream;
      }
    });

    const firstRun = agent.prompt('first run');
    await streamStartedPromise;
    agent.abort();
    await firstRun;
    await agent.prompt('second run');
    expect(agent.state.messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'second run' }]
    });
  });

  it('should honor parallel tool execution in the agent loop', async () => {
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const makeTool = (name: string): AgentTool => ({
      name,
      description: name,
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { content: [{ type: 'text', text: name }] };
      }
    });

    const agent = new Agent({
      toolExecution: 'parallel',
      initialState: {
        model: getModelPreset('mock-test'),
        tools: [makeTool('one'), makeTool('two')]
      },
      streamFn: () => {
        const stream = new AssistantEventStream();
        calls += 1;
        if (calls === 1) {
          for (const [id, name] of [['call-one', 'one'], ['call-two', 'two']] as const) {
            stream.push({ type: 'tool_call_start', toolCallId: id, toolName: name });
            stream.push({ type: 'tool_call_delta', toolCallId: id, argsDelta: '{}' });
            stream.push({
              type: 'tool_call_end',
              toolCall: { type: 'toolCall', id, name, arguments: {} }
            });
          }
        } else {
          stream.push({ type: 'text_delta', textDelta: 'done' });
        }
        stream.end();
        return stream;
      }
    });

    await agent.prompt('run tools');
    expect(maxActive).toBe(2);
    expect(agent.state.messages.filter((message) => message.role === 'toolResult')).toHaveLength(2);
  });

  it('should convert hook failures into terminal tool results and clear pending calls', async () => {
    for (const hook of ['before', 'after'] as const) {
      const agent = new Agent({
        initialState: { model: getModelPreset('mock-test') },
        ...(hook === 'before'
          ? { beforeToolCall: async () => { throw new Error('before failed'); } }
          : { afterToolCall: async () => { throw new Error('after failed'); } }),
        streamFn: () => {
          const stream = new AssistantEventStream();
          stream.push({ type: 'tool_call_start', toolCallId: 'call', toolName: 'tool' });
          stream.push({ type: 'tool_call_delta', toolCallId: 'call', argsDelta: '{}' });
          stream.push({
            type: 'tool_call_end',
            toolCall: { type: 'toolCall', id: 'call', name: 'tool', arguments: {} }
          });
          stream.end();
          return stream;
        }
      });
      agent.getToolRegistry().register({
        name: 'tool',
        description: 'tool',
        parameters: { type: 'object', properties: {} },
        execute: async () => ({ content: [{ type: 'text', text: 'ok' }] })
      });

      await agent.prompt(`run ${hook}`);
      expect(agent.state.pendingToolCalls.size).toBe(0);
      expect(agent.state.messages.at(-1)).toMatchObject({
        role: 'toolResult',
        isError: true,
        terminate: true
      });
      expect((agent.state.messages.at(-1) as any).content[0].text).toContain(`${hook} failed`);
    }
  });

  it('should test ExtensionHost commands, shortcuts, and Runner loadAll', async () => {
    const host = new ExtensionHost();
    const runner = new ExtensionRunner(host);

    host.registerCommand({
      name: 'ping',
      description: 'Ping command',
      execute: async () => 'pong'
    });
    expect(host.getCommand('ping')).toBeDefined();
    expect(host.getCommands().length).toBe(1);

    host.registerShortcut({
      key: 'Ctrl+S',
      description: 'Quick save',
      execute: async () => true
    });
    expect(host.getShortcuts().length).toBe(1);

    await runner.loadAll([
      {
        name: 'ext1',
        factory: (pi) => {
          pi.registerTool({
            name: 'ext_tool_1',
            description: 'ext tool',
            execute: async () => ({ content: [{ type: 'text', text: '1' }] })
          });
        }
      }
    ]);

    expect(host.getTools().some((t) => t.name === 'ext_tool_1')).toBe(true);
  });
});
