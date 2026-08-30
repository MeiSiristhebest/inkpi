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
import { getModelPreset } from '@inkpi/ai';

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
    const tree = new SessionTree();
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

    tree.clear();
    expect(tree.size()).toBe(0);
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
