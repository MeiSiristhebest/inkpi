import { fileURLToPath } from 'node:url';
import {
  ContextPipeline,
  type ContextProvider,
  ExtensionHost,
  ProgressiveSkillRuntime,
  type SkillActivationContext,
  type TaskHandler,
  TaskRegistry,
  ToolRegistry
} from '@inkpi/agent-core';
import type { AgentTool, PipelineHooks } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

const firstPartySkillsDir = fileURLToPath(new URL('../skills/', import.meta.url));

const firstPartyNames = ['hook', 'promise', 'character-voice', 'timeline-consistency'] as const;
type FirstPartySkillName = (typeof firstPartyNames)[number];

describe('first-party skill activation', () => {
  it('discovers, lazily loads, and activates each real manifest on shared runtime surfaces', async () => {
    const extensionHost = new ExtensionHost();
    const toolRegistry = new ToolRegistry();
    const taskRegistry = new TaskRegistry();
    const contextPipeline = new ContextPipeline();
    const attempts: Record<FirstPartySkillName, number> = {
      hook: 0,
      promise: 0,
      'character-voice': 0,
      'timeline-consistency': 0
    };
    const seenBodies: Partial<Record<FirstPartySkillName, string>> = {};

    const hookPipelineHooks: PipelineHooks = {
      onBeforeStage: ({ prompt }) => `${prompt} [hook active]`
    };
    const promiseTask: TaskHandler = {
      id: 'first-party.promise',
      kinds: ['creative.continue', 'creative.rewrite'],
      execute: async () => ({ output: { format: 'text', text: 'promise tracked' } })
    };
    const characterVoiceTool: AgentTool = {
      name: 'first-party.character-voice',
      description: 'Apply the first-party character voice constraints.',
      execute: async () => ({ content: [{ type: 'text', text: 'voice checked' }] })
    };
    const timelineProvider: ContextProvider = {
      id: 'first-party.timeline-consistency',
      provide: () => [
        {
          id: 'first-party.timeline-consistency.fragment',
          source: 'timeline-consistency',
          text: 'timeline evidence'
        }
      ]
    };

    const assertSharedContext = (context: SkillActivationContext, name: FirstPartySkillName, bodyMarker: string) => {
      expect(context.skill.name).toBe(name);
      expect(context.skill.promptBody).toContain(bodyMarker);
      expect(context.extensionHost).toBe(extensionHost);
      expect(context.toolRegistry).toBe(toolRegistry);
      expect(context.taskRegistry).toBe(taskRegistry);
      expect(context.contextPipeline).toBe(contextPipeline);
      seenBodies[name] = context.skill.promptBody;
    };

    const runtime = new ProgressiveSkillRuntime({
      searchDirs: [firstPartySkillsDir],
      extensionHost,
      toolRegistry,
      taskRegistry,
      contextPipeline,
      skillActivators: {
        hook: (context) => {
          assertSharedContext(context, 'hook', 'strongest');
          attempts.hook += 1;
          context.api.registerPipelineHooks(hookPipelineHooks);
          if (attempts.hook === 1) throw new Error('hook activation failed once');
        },
        promise: (context) => {
          assertSharedContext(context, 'promise', 'Track each promise');
          attempts.promise += 1;
          context.registerTask(promiseTask);
          if (attempts.promise === 1) throw new Error('promise activation failed once');
        },
        'character-voice': (context) => {
          assertSharedContext(context, 'character-voice', 'established diction');
          attempts['character-voice'] += 1;
          context.registerTool(characterVoiceTool);
          if (attempts['character-voice'] === 1) throw new Error('character-voice activation failed once');
        },
        'timeline-consistency': (context) => {
          assertSharedContext(context, 'timeline-consistency', 'explicit dates');
          attempts['timeline-consistency'] += 1;
          context.registerContext(timelineProvider);
          if (attempts['timeline-consistency'] === 1) throw new Error('timeline-consistency activation failed once');
        }
      }
    });

    expect(runtime.discover()).toEqual([
      { name: 'character-voice', description: expect.any(String), loaded: false },
      { name: 'hook', description: expect.any(String), loaded: false },
      { name: 'promise', description: expect.any(String), loaded: false },
      { name: 'timeline-consistency', description: expect.any(String), loaded: false }
    ]);
    expect(runtime.listLoaded()).toEqual([]);
    expect(runtime.discoverManifests()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'hook',
          activation: 'on-demand',
          capabilities: ['narrative-hook', 'creative-writing'],
          taskKinds: ['creative.continue', 'creative.rewrite']
        }),
        expect.objectContaining({
          id: 'promise',
          activation: 'lazy',
          capabilities: ['story-promise', 'continuity-audit'],
          taskKinds: ['creative.continue', 'creative.rewrite', 'narrative.continuity.audit']
        }),
        expect.objectContaining({
          id: 'character-voice',
          activation: 'eager',
          capabilities: ['character-voice', 'creative-writing'],
          taskKinds: ['creative.continue', 'creative.rewrite', 'narrative.deep.reason']
        }),
        expect.objectContaining({
          id: 'timeline-consistency',
          activation: 'on-demand',
          capabilities: ['timeline-consistency', 'continuity-audit'],
          taskKinds: ['narrative.continuity.audit', 'narrative.project.distill']
        })
      ])
    );
    expect(runtime.listLoaded()).toEqual([]);

    const activateWithRollbackAndRetry = async (
      name: FirstPartySkillName,
      bodyMarker: string,
      assertRolledBack: () => void
    ) => {
      await expect(runtime.activate(name)).rejects.toThrow(`${name} activation failed once`);
      expect(runtime.listActivated()).not.toContain(name);
      assertRolledBack();

      const firstRetry = runtime.activate(name);
      const concurrentRetry = runtime.activate(name);
      const [firstResult, concurrentResult] = await Promise.all([firstRetry, concurrentRetry]);
      expect(firstResult.promptBody).toContain(bodyMarker);
      expect(concurrentResult.promptBody).toContain(bodyMarker);
      expect(attempts[name]).toBe(2);

      const idempotentResult = await runtime.activate(name);
      expect(idempotentResult.promptBody).toContain(bodyMarker);
      expect(attempts[name]).toBe(2);
    };

    await activateWithRollbackAndRetry('hook', 'strongest', () => {
      expect(extensionHost.getPipelineHooks()).toEqual([]);
    });
    await activateWithRollbackAndRetry('promise', 'Track each promise', () => {
      expect(taskRegistry.list()).toEqual([]);
      expect(extensionHost.getPipelineHooks()).toEqual([hookPipelineHooks]);
    });
    await activateWithRollbackAndRetry('character-voice', 'established diction', () => {
      expect(extensionHost.getTools()).toEqual([]);
      expect(toolRegistry.getAll()).toEqual([]);
      expect(taskRegistry.list()).toEqual([promiseTask]);
    });
    await activateWithRollbackAndRetry('timeline-consistency', 'explicit dates', () => {
      expect(contextPipeline.list()).toEqual([]);
      expect(toolRegistry.getAll()).toEqual([characterVoiceTool]);
    });

    expect(runtime.extensionHost).toBe(extensionHost);
    expect(runtime.toolRegistry).toBe(toolRegistry);
    expect(runtime.taskRegistry).toBe(taskRegistry);
    expect(runtime.contextPipeline).toBe(contextPipeline);
    expect(runtime.listLoaded()).toEqual([...firstPartyNames].sort());
    expect(runtime.listActivated()).toEqual([...firstPartyNames].sort());
    expect(Object.keys(seenBodies).sort()).toEqual([...firstPartyNames].sort());
    expect(extensionHost.getPipelineHooks()).toEqual([hookPipelineHooks]);
    expect(extensionHost.getTools()).toEqual([characterVoiceTool]);
    expect(toolRegistry.getAll()).toEqual([characterVoiceTool]);
    expect(taskRegistry.list()).toEqual([promiseTask]);
    expect(contextPipeline.list()).toEqual([timelineProvider]);
  });
});
