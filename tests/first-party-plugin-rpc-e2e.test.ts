import { InkRpcClient } from '@inkpi/client';
import type { AiTask, ToolExecuteParams } from '@inkpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InkPiDaemon } from '../packages/server/src/daemon.js';

describe('first-party plugin Runtime RPC boundary', () => {
  const daemons: InkPiDaemon[] = [];
  const clients: InkRpcClient[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  });

  it('lists and executes a Runtime Tool and completes a Runtime Workflow over TCP', async () => {
    const daemon = new InkPiDaemon({ port: 0, host: '127.0.0.1' });
    daemons.push(daemon);
    await daemon.start();
    const client = await InkRpcClient.connectTcp(daemon.getPort(), '127.0.0.1');
    clients.push(client);

    const tools = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'plugin.diff-reviewer.compute',
      'plugin.memory-palace.search',
      'plugin.press-forge.format',
      'plugin.scrapbook-recycler.recommend'
    ]);

    const toolParams: ToolExecuteParams = {
      toolName: 'plugin.press-forge.format',
      toolCallId: 'tcp-press-forge',
      arguments: { rawContent: 'hello, world!' }
    };
    const toolResult = await client.executeTool(toolParams);
    expect(toolResult).toMatchObject({
      role: 'toolResult',
      toolCallId: 'tcp-press-forge',
      toolName: 'plugin.press-forge.format',
      isError: false,
      details: { formattedText: expect.stringContaining('hello， world！') }
    });

    const task: AiTask = {
      id: 'tcp-storyboard-workflow',
      kind: 'plugin.storyboard-gen.workflow',
      input: {
        payload: {
          chapterId: 'ch-tcp',
          chapterTitle: 'TCP climax',
          chapterText: 'The hero raises a sword.\nThe gate breaks.',
          context: { protagonist: 'Hero', antagonist: 'Rival' }
        }
      },
      intent: 'Build a storyboard',
      outputContract: { format: 'structured' },
      executionPolicy: { strategy: 'workflow', mode: 'foreground' }
    };
    await client.submitTask(task);
    const taskResult = await client.waitForTask(task.id);
    expect(taskResult).toMatchObject({
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      output: { format: 'structured', data: { frames: expect.any(Array) } },
      provenance: { pluginId: 'storyboard-gen', runtimeClass: 'workflow' }
    });
  });
});
