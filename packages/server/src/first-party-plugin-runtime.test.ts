import { ExtensionHost, TaskRegistry, ToolRegistry } from '@inkpi/agent-core';
import type { AiTask, ToolCallContent } from '@inkpi/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { InkPiDaemon } from './daemon.js';
import {
  FIRST_PARTY_RUNTIME_TOOL_NAMES,
  FIRST_PARTY_RUNTIME_WORKFLOW_KINDS,
  registerFirstPartyPluginRuntime
} from './first-party-plugin-runtime.js';

function toolCall(name: string, arguments_: Record<string, unknown>): ToolCallContent {
  return { type: 'toolCall', id: `test-${name}`, name, arguments: arguments_ };
}

function task(id: string, kind: string, payload: unknown, intent = kind): AiTask {
  return {
    id,
    kind,
    intent,
    input: { payload },
    outputContract: { format: 'structured' },
    executionPolicy: { strategy: 'workflow', mode: 'foreground' },
    checkpointPolicy: { enabled: true, step: 'plugin-runtime' }
  };
}

describe('first-party Runtime plugin registration', () => {
  const daemons: InkPiDaemon[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
  });

  it('registers all six classification-only plugins in the shared Runtime registries', () => {
    const daemon = new InkPiDaemon();
    daemons.push(daemon);

    expect(daemon.getFirstPartyPluginRuntime().toolNames).toEqual([...FIRST_PARTY_RUNTIME_TOOL_NAMES]);
    expect(daemon.getFirstPartyPluginRuntime().workflowKinds).toEqual([...FIRST_PARTY_RUNTIME_WORKFLOW_KINDS]);
    expect(daemon.getTaskRouter().toolRegistry.getAll()).toHaveLength(4);
    expect(
      daemon
        .getTaskRouter()
        .registry.list()
        .filter((handler) => handler.id.startsWith('first-party.workflow.'))
    ).toHaveLength(2);

    for (const name of FIRST_PARTY_RUNTIME_TOOL_NAMES) {
      expect(daemon.getTaskRouter().toolRegistry.getRegistration(name)).toMatchObject({
        name,
        source: 'first-party-plugin-runtime',
        capabilities: ['first-party-plugin', 'offline']
      });
      expect(daemon.getSkillRuntime().extensionHost.getToolRegistration(name)).toMatchObject({
        name,
        source: 'first-party-plugin-runtime'
      });
    }
    for (const kind of FIRST_PARTY_RUNTIME_WORKFLOW_KINDS) {
      expect(
        daemon.getTaskRouter().registry.resolve({
          id: `resolve-${kind}`,
          kind,
          input: {}
        })
      ).toEqual(expect.objectContaining({ id: expect.stringContaining('first-party.workflow.') }));
    }
  });

  it('executes the four registered tools without a provider or Desktop process', async () => {
    const daemon = new InkPiDaemon();
    daemons.push(daemon);
    const registry = daemon.getTaskRouter().toolRegistry;

    const diff = await registry.executeTool(
      toolCall('plugin.diff-reviewer.compute', {
        oldText: 'before\nstable',
        newText: 'after\nstable'
      })
    );
    expect(diff.isError).not.toBe(true);
    expect(diff.details).toMatchObject({ stats: { additions: 1, deletions: 1 } });

    const memory = await registry.executeTool(
      toolCall('plugin.memory-palace.search', {
        query: 'Mira',
        entities: [{ id: 'hero-1', name: 'Mira', aliases: ['M'], category: 'character' }],
        chapters: [
          { id: 'ch-2', order: 2, title: 'Storm', content: 'Mira enters the storm.' },
          { id: 'ch-1', order: 1, title: 'Arrival', content: 'Mira arrives.' }
        ]
      })
    );
    expect(memory.isError).not.toBe(true);
    expect(memory.details).toMatchObject([
      expect.objectContaining({
        entityId: 'hero-1',
        totalOccurrences: 2,
        firstAppearedChapter: expect.objectContaining({ order: 1 })
      })
    ]);

    const press = await registry.executeTool(
      toolCall('plugin.press-forge.format', {
        rawContent: 'hello, world!\n\nsecret',
        options: { indentSpaces: 0, paragraphSpacing: 0, sensitiveWords: ['secret'] }
      })
    );
    expect(press.isError).not.toBe(true);
    expect(press.details).toMatchObject({
      formattedText: 'hello， world！\nsecret',
      warnings: ['Sensitive word detected: secret']
    });

    const scrapbook = await registry.executeTool(
      toolCall('plugin.scrapbook-recycler.recommend', {
        contextText: 'storm ally returns',
        fragments: [
          { id: 'fragment-1', snippet: 'The storm ally returns.', isReused: false },
          { id: 'fragment-2', snippet: 'A quiet room.', isReused: false },
          { id: 'fragment-3', snippet: 'storm ally returns', isReused: true }
        ],
        topK: 2
      })
    );
    expect(scrapbook.isError).not.toBe(true);
    expect(scrapbook.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ fragment: expect.objectContaining({ id: 'fragment-1' }) })])
    );
    expect(scrapbook.details).toHaveLength(2);
    expect(scrapbook.details).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ fragment: expect.objectContaining({ id: 'fragment-3' }) })])
    );
  });

  it('exposes only first-party tools through the explicit RPC boundary', async () => {
    const daemon = new InkPiDaemon();
    daemons.push(daemon);

    const listed = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 'list-tools',
      method: 'tool.list',
      params: {}
    });
    expect(listed.error).toBeUndefined();
    expect(listed.result).toEqual(
      expect.arrayContaining(FIRST_PARTY_RUNTIME_TOOL_NAMES.map((name) => expect.objectContaining({ name })))
    );
    expect(listed.result).toHaveLength(4);

    const executed = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 'execute-tool',
      method: 'tool.execute',
      params: {
        toolName: 'plugin.diff-reviewer.compute',
        toolCallId: 'rpc-diff-test',
        arguments: { oldText: 'a', newText: 'b' }
      }
    });
    expect(executed.error).toBeUndefined();
    expect(executed.result).toMatchObject({
      role: 'toolResult',
      toolCallId: 'rpc-diff-test',
      toolName: 'plugin.diff-reviewer.compute',
      isError: false
    });

    const rejected = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 'execute-hidden-tool',
      method: 'tool.execute',
      params: { toolName: 'not-exposed', arguments: {} }
    });
    expect(rejected.error?.message).toContain('not exposed');
  });

  it('runs the two registered workflows through TaskRouter checkpoints', async () => {
    const daemon = new InkPiDaemon();
    daemons.push(daemon);
    const router = daemon.getTaskRouter();
    await router.ready;

    const multiverse = task('first-party-multiverse-test', 'plugin.multiverse-whatif.workflow', {
      canonChapters: [
        { index: 1, title: 'Arrival', summary: 'The hero arrives.', entities: ['Mira'] },
        { index: 2, title: 'Storm', summary: 'The storm starts.', entities: ['Mira', 'Rook'] },
        { index: 3, title: 'Aftermath', summary: 'The allies regroup.', entities: ['Mira'] }
      ],
      forkChapterIndex: 2,
      divergencePremise: 'Mira accepts the forbidden alliance.'
    });
    router.submit(multiverse);
    await expect(router.wait(multiverse.id)).resolves.toMatchObject({
      status: 'completed',
      output: { format: 'structured' },
      provenance: { pluginId: 'multiverse-whatif', runtimeClass: 'workflow' }
    });
    const multiverseResult = await router.wait(multiverse.id);
    expect(multiverseResult.output).toMatchObject({ format: 'structured', data: { nodes: expect.any(Array) } });

    const storyboard = task('first-party-storyboard-test', 'plugin.storyboard-gen.workflow', {
      chapterId: 'chapter-7',
      chapterTitle: 'The Reversal',
      chapterText: 'Mira crosses the bridge.\nThe rival raises a sword.\nThunder breaks the gate.',
      context: { protagonist: 'Mira', antagonist: 'Rook' }
    });
    router.submit(storyboard);
    const storyboardResult = await router.wait(storyboard.id);
    expect(storyboardResult).toMatchObject({
      status: 'completed',
      output: { format: 'structured', data: { frames: expect.any(Array) } },
      provenance: { pluginId: 'storyboard-gen', runtimeClass: 'workflow' }
    });
    expect((storyboardResult.output as { format: 'structured'; data: { frames: unknown[] } }).data.frames).toHaveLength(
      4
    );
  });

  it('queues structured first-party workflows with an explicit OpenAI-compatible route', async () => {
    const daemon = new InkPiDaemon({
      modelRoutes: [
        {
          id: 'openai-compatible-text-only',
          model: {
            id: 'openai-compatible-model',
            name: 'OpenAI-compatible model',
            provider: 'openai'
          },
          capabilities: { outputFormats: ['text'] }
        }
      ]
    });
    daemons.push(daemon);
    await daemon.getTaskRouter().ready;

    const workflow = task('first-party-openai-compatible-workflow', 'plugin.storyboard-gen.workflow', {
      chapterId: 'chapter-openai-compatible',
      chapterTitle: 'The Gate',
      chapterText: 'The hero enters.\nThe rival waits.',
      context: { protagonist: 'Hero', antagonist: 'Rival' }
    });
    const response = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 'first-party-openai-compatible-submit',
      method: 'task.submit',
      params: { task: workflow }
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ taskId: workflow.id, status: 'queued' });
    await expect(daemon.getTaskRouter().wait(workflow.id)).resolves.toMatchObject({
      status: 'completed',
      output: { format: 'structured', data: { frames: expect.any(Array) } },
      provenance: { pluginId: 'storyboard-gen', runtimeClass: 'workflow' }
    });
  });

  it('is idempotent and only disposes registrations created by the caller', () => {
    const toolRegistry = new ToolRegistry();
    const taskRegistry = new TaskRegistry();
    const extensionHost = new ExtensionHost();
    const first = registerFirstPartyPluginRuntime({ toolRegistry, taskRegistry, extensionHost });
    const second = registerFirstPartyPluginRuntime({ toolRegistry, taskRegistry, extensionHost });

    expect(toolRegistry.getAll()).toHaveLength(4);
    expect(taskRegistry.list()).toHaveLength(2);
    expect(extensionHost.getTools()).toHaveLength(4);

    second.dispose();
    expect(toolRegistry.getAll()).toHaveLength(4);
    expect(taskRegistry.list()).toHaveLength(2);
    first.dispose();
    expect(toolRegistry.getAll()).toHaveLength(0);
    expect(taskRegistry.list()).toHaveLength(0);
    expect(extensionHost.getTools()).toHaveLength(0);
  });
});
