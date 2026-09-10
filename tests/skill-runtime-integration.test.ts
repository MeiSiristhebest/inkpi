import {
  ContextPipeline,
  ExtensionHost,
  ProgressiveSkillRuntime,
  type SkillDiscoveryEngine,
  TaskRegistry,
  ToolRegistry
} from '@inkpi/agent-core';
import type { AgentMessage, ContextTransformer, SkillInfo } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import type { ContextProvider } from '../packages/agent-core/src/context/types.js';
import type { SkillActivator } from '../packages/agent-core/src/skills/progressive-disclosure.js';
import type { TaskHandler } from '../packages/agent-core/src/tasks/task-handler.js';

function makeSkill(name: string, promptBody = ''): SkillInfo {
  return {
    name,
    description: `${name} skill`,
    filePath: `${name}.md`,
    frontmatter: { id: name, activation: 'lazy' },
    promptBody
  };
}

function makeDiscovery(metadata: SkillInfo, loaded: SkillInfo): SkillDiscoveryEngine {
  return {
    discover: () => [metadata],
    loadSkill: () => loaded,
    getSkill: () => metadata
  } as unknown as SkillDiscoveryEngine;
}

describe('ProgressiveSkillRuntime lifecycle bridge', () => {
  it('loads the body first and registers resources into shared runtime surfaces', async () => {
    const extensionHost = new ExtensionHost();
    const toolRegistry = new ToolRegistry();
    const taskRegistry = new TaskRegistry();
    const contextPipeline = new ContextPipeline();
    const metadata = makeSkill('lifecycle-skill');
    const loaded = makeSkill('lifecycle-skill', 'loaded skill body');
    let bodyLoads = 0;

    const discovery = makeDiscovery(metadata, loaded);
    discovery.loadSkill = () => {
      bodyLoads += 1;
      return loaded;
    };

    const runtime = new ProgressiveSkillRuntime({
      discovery,
      extensionHost,
      toolRegistry,
      taskRegistry,
      contextPipeline
    });
    const tool = {
      name: 'skill_lookup',
      description: 'Lookup skill data',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })
    };
    const task: TaskHandler = {
      id: 'skill-task',
      kinds: ['skill.test'],
      execute: async () => ({ output: { format: 'text', text: 'done' } })
    };
    const provider: ContextProvider = {
      id: 'skill-context',
      provide: () => [{ id: 'skill-fragment', source: 'skill', text: 'skill context' }]
    };
    const marker: AgentMessage = { role: 'user', content: 'skill transformer', timestamp: 1 };
    const transformer: ContextTransformer = async () => [marker];
    let seenBody = '';
    const activator: SkillActivator = ({ skill, api, registerTask, registerContext, registerContextTransformer }) => {
      seenBody = skill.promptBody;
      api.registerTool(tool);
      registerTask(task);
      registerContext(provider);
      registerContextTransformer(transformer);
    };

    runtime.registerSkill(metadata, activator);
    expect(runtime.discover()).toEqual([
      { name: 'lifecycle-skill', description: 'lifecycle-skill skill', loaded: false }
    ]);
    expect(bodyLoads).toBe(0);

    const result = await runtime.activate('lifecycle-skill');

    expect(result.promptBody).toBe('loaded skill body');
    expect(seenBody).toBe('loaded skill body');
    expect(bodyLoads).toBe(1);
    expect(runtime.extensionHost).toBe(extensionHost);
    expect(runtime.toolRegistry).toBe(toolRegistry);
    expect(runtime.taskRegistry).toBe(taskRegistry);
    expect(runtime.contextPipeline).toBe(contextPipeline);
    expect(extensionHost.getTools()).toEqual([tool]);
    expect(toolRegistry.getAll()).toEqual([tool]);
    expect(taskRegistry.list()).toEqual([task]);
    expect(contextPipeline.list()).toEqual([provider]);
    await expect(extensionHost.transformContext([])).resolves.toEqual([marker]);
    expect(runtime.listLoaded()).toEqual(['lifecycle-skill']);
    expect(runtime.listActivated()).toEqual(['lifecycle-skill']);
  });

  it('rolls back a failed activation, retries, and deduplicates concurrent activation', async () => {
    const extensionHost = new ExtensionHost();
    const toolRegistry = new ToolRegistry();
    const taskRegistry = new TaskRegistry();
    const contextPipeline = new ContextPipeline();
    const metadata = makeSkill('retryable-skill');
    const loaded = makeSkill('retryable-skill', 'retry body');
    const runtime = new ProgressiveSkillRuntime({
      discovery: makeDiscovery(metadata, loaded),
      extensionHost,
      toolRegistry,
      taskRegistry,
      contextPipeline
    });
    const tool = {
      name: 'retry_tool',
      description: 'Retry tool',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })
    };
    const task: TaskHandler = {
      id: 'retry-task',
      kinds: ['skill.retry'],
      execute: async () => ({})
    };
    const provider: ContextProvider = {
      id: 'retry-context',
      provide: () => []
    };
    let attempts = 0;
    const activator: SkillActivator = ({ registerTool, registerTask, registerContext }) => {
      attempts += 1;
      registerTool(tool);
      registerTask(task);
      registerContext(provider);
      if (attempts === 1) throw new Error('transient activation failure');
    };

    await expect(runtime.activate('retryable-skill', activator)).rejects.toThrow('transient activation failure');
    expect(runtime.listActivated()).toEqual([]);
    expect(extensionHost.getTools()).toEqual([]);
    expect(toolRegistry.getAll()).toEqual([]);
    expect(taskRegistry.list()).toEqual([]);
    expect(contextPipeline.list()).toEqual([]);

    const first = runtime.activate('retryable-skill', activator);
    const second = runtime.activate('retryable-skill', activator);
    await Promise.all([first, second]);
    await runtime.activate('retryable-skill', activator);

    expect(attempts).toBe(2);
    expect(extensionHost.getTools()).toEqual([tool]);
    expect(toolRegistry.getAll()).toEqual([tool]);
    expect(taskRegistry.list()).toEqual([task]);
    expect(contextPipeline.list()).toEqual([provider]);
    expect(runtime.listActivated()).toEqual(['retryable-skill']);
  });
});
