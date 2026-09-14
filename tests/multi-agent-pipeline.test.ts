import { RoleRegistry, WorkflowCoordinator, extractRuntimeState } from '@inkpi/agent-core';
import { getModelPreset } from '@inkpi/ai';
import { formatChineseTypography } from '@inkpi/editor-core';
import type { AgentMessage, RuntimeState, WorkflowStageConfig } from '@inkpi/protocol';
import { creativeStateExtractor, readCreativeRuntimeState } from './fixtures/domain-adapters.js';

function narrativeStages(): WorkflowStageConfig[] {
  return [
    { id: 'outline', name: '结构大纲规划', role: 'architect' },
    { id: 'draft', name: '正文主创展开', role: 'writer' },
    { id: 'audit', name: '约束与一致性审计', role: 'critic' },
    {
      id: 'polish',
      name: '排版校对与润色',
      role: 'polisher',
      transformOutput: (output) => formatChineseTypography(output)
    }
  ];
}

function extractState(output: string) {
  const messages: AgentMessage[] = [{ role: 'assistant', content: [{ type: 'text', text: output }] }];
  return extractRuntimeState(messages, [creativeStateExtractor]);
}

describe('Multi-Agent Collaborative Pipeline', () => {
  it('should support dynamic role registration in RoleRegistry (100% pure & decoupled from core)', () => {
    const registry = new RoleRegistry();
    expect(registry.getAll().length).toBe(0);

    registry.register('screenwriter', {
      role: 'screenwriter',
      name: '影视编剧',
      systemPrompt: '负责剧本三幕剧结构与场次对白'
    });

    expect(registry.has('screenwriter')).toBe(true);
    expect(registry.get('screenwriter')?.name).toBe('影视编剧');
    expect(registry.get('screenwriter')?.systemPrompt).toContain('三幕剧');
  });

  it('should execute full 4-stage pipeline with event streaming and injected state merging', async () => {
    const events: string[] = [];
    const pipeline = new WorkflowCoordinator({
      model: getModelPreset('mock-test'),
      stages: narrativeStages(),
      customExecutor: async (role) => {
        if (role === 'architect') return '<entity name="First" status="active" /> <asset name="Key" holder="First" />';
        if (role === 'writer') return '<track clue="Archive" status="pending" /> <location name="Harbor" />';
        if (role === 'critic') return 'audit passed';
        return 'polished output';
      },
      stateExtractor: extractState
    });

    pipeline.subscribe((ev) => {
      events.push(ev.type);
    });

    const result = await pipeline.runWorkflow({
      title: '仙魔道',
      sectionTitle: '第一document 灵脉复苏',
      input: '主角发现古修遗迹并战胜窥探的杂役弟子',
      state: {
        entities: [
          { name: 'UserE', status: '练气三层' },
          { name: '老者', status: '神秘' }
        ],
        assets: [{ name: '残破铜镜', owner: 'UserE' }],
        tracks: [],
        locations: [{ name: '青石镇' }],
        modifiedDocuments: ['序document']
      } satisfies RuntimeState
    });

    expect(events).toContain('stage_start');
    expect(events).toContain('stage_end');
    expect(events).toContain('workflow_complete');

    expect(result.outputs.outline).toBeDefined();
    expect(result.outputs.draft).toBeDefined();
    expect(result.outputs.audit).toBeDefined();
    expect(result.outputs.polish).toBeDefined();
    expect(result.logs.length).toBe(4);

    // Verify Chinese typography was applied by polisher (fullwidth indent)
    expect(result.outputs.polish).toContain('　　');
    const state = readCreativeRuntimeState(result.state);
    expect(state.entities.some((entity) => entity.name === 'First')).toBe(true);
    expect(state.assets.some((asset) => asset.name === 'Key')).toBe(true);
    expect(state.tracks.some((track) => track.clue === 'Archive')).toBe(true);
    expect(state.locations.some((location) => location.name === 'Harbor')).toBe(true);
  });

  it('should allow custom role executor injection', async () => {
    const pipeline = new WorkflowCoordinator({
      stages: narrativeStages(),
      customExecutor: async (role, sysPrompt, userPrompt) => {
        return `[Custom ${role}] executed: ${userPrompt.slice(0, 10)}`;
      }
    });

    const res = await pipeline.runWorkflow({
      title: 'workspace名',
      sectionTitle: 'document节',
      input: '测试请求'
    });
    expect(res.outputs.outline).toContain('[Custom architect]');
    expect(res.outputs.draft).toContain('[Custom writer]');
  });

  it('should preserve generic workflow state extensions and merge records by identity', async () => {
    const coordinator = new WorkflowCoordinator({
      stages: [
        {
          id: 'collect',
          name: 'Collect',
          executor: async () => ({
            text: 'collected',
            statePatch: {
              entities: [{ id: 'entity-1', name: 'Renamed', status: 'updated' }],
              assets: [{ id: 'asset-2', name: 'Added Asset' }],
              tracks: [{ id: 'track-2', clue: 'new clue', status: 'pending' }],
              locations: [{ id: 'location-2', name: 'New Place' }],
              modifiedResources: ['resource-2'],
              customExtension: { source: 'stage' }
            }
          })
        },
        {
          id: 'finish',
          name: 'Finish',
          executor: async (ctx) => ({
            text: `seen:${ctx.state.entities[0]?.status}`,
            statePatch: {
              entities: [{ id: 'entity-1', name: 'Renamed Again' }],
              modifiedResources: ['resource-3'],
              customExtension: { source: 'finish', preserved: true }
            }
          })
        }
      ]
    });

    const result = await coordinator.runWorkflow({
      input: 'generic request',
      state: {
        entities: [{ id: 'entity-1', name: 'Original', status: 'initial' }],
        assets: [{ id: 'asset-1', name: 'Original Asset' }],
        tracks: [{ id: 'track-1', clue: 'existing clue', status: 'pending' }],
        locations: [{ id: 'location-1', name: 'Existing Place' }],
        modifiedResources: ['resource-1'],
        customExtension: { source: 'initial' }
      }
    });

    expect(result.outputs).toEqual({
      collect: 'collected',
      finish: 'seen:updated'
    });
    expect(result.state.entities).toEqual([{ id: 'entity-1', name: 'Renamed Again', status: 'updated' }]);
    expect(result.state.assets).toEqual([
      { id: 'asset-1', name: 'Original Asset' },
      { id: 'asset-2', name: 'Added Asset' }
    ]);
    expect(result.state.tracks).toEqual([
      { id: 'track-1', clue: 'existing clue', status: 'pending' },
      { id: 'track-2', clue: 'new clue', status: 'pending' }
    ]);
    expect(result.state.locations).toEqual([
      { id: 'location-1', name: 'Existing Place' },
      { id: 'location-2', name: 'New Place' }
    ]);
    expect(result.state.modifiedResources).toEqual(['resource-1', 'resource-2', 'resource-3']);
    expect(result.state.customExtension).toEqual({ source: 'finish', preserved: true });
    expect(result.state).not.toHaveProperty('characters');
    expect(result.state).not.toHaveProperty('items');
    expect(result.state).not.toHaveProperty('foreshadowings');
    expect(result.state).not.toHaveProperty('modifiedDocuments');
  });

  it('should execute generic lifecycle hooks for arbitrary stage ids without novel stage semantics', async () => {
    const before: string[] = [];
    const after: string[] = [];
    const outputs: string[] = [];
    const coordinator = new WorkflowCoordinator({
      hooks: [
        {
          onBeforeStage: ({ stageId, prompt }) => {
            before.push(`${stageId}:${prompt}`);
            return `${prompt} [before]`;
          },
          onAfterStage: ({ stageId, output }) => {
            after.push(`${stageId}:${output}`);
            return `${output} [after]`;
          },
          onStageOutput: ({ stageId, output }) => {
            outputs.push(`${stageId}:${output}`);
          }
        }
      ],
      stages: [{ id: 'outline', name: 'A generic outline-named stage', executor: async () => 'raw' }]
    });

    const result = await coordinator.runWorkflow({ input: 'request' });
    expect(before).toEqual(['outline:request']);
    expect(after).toEqual(['outline:raw']);
    expect(outputs).toEqual(['outline:raw [after]']);
    expect(result.outputs.outline).toBe('raw [after]');
  });

  it('should pass the execution signal to stages and stop before later stages after abort', async () => {
    const controller = new AbortController();
    const receivedSignals: AbortSignal[] = [];
    let secondStageRan = false;
    const coordinator = new WorkflowCoordinator({
      signal: controller.signal,
      stages: [
        {
          id: 'first',
          name: 'First',
          executor: async (_ctx, signal) => {
            receivedSignals.push(signal!);
            controller.abort();
            return 'first output';
          }
        },
        {
          id: 'second',
          name: 'Second',
          executor: async () => {
            secondStageRan = true;
            return 'second output';
          }
        }
      ]
    });

    await expect(coordinator.runWorkflow({ input: 'request' })).rejects.toThrow(
      "Workflow aborted before stage 'second'"
    );
    expect(receivedSignals).toEqual([controller.signal]);
    expect(secondStageRan).toBe(false);
  });

  it('should test progress callback event stream', async () => {
    const model = getModelPreset('mock-test');
    model.fauxScript = { text: 'provider stage output', inputTokens: 5, outputTokens: 7 };
    const pipeline = new WorkflowCoordinator({ model, stages: narrativeStages() });
    const progressLogs: string[] = [];
    const unsubscribe = pipeline.subscribe((ev) => {
      if (ev.type === 'stage_start' || ev.type === 'stage_end') {
        progressLogs.push(`${ev.type}:${ev.stage}`);
      }
    });

    await pipeline.runWorkflow({
      title: '新workspace',
      sectionTitle: '第一回',
      input: '正文开端',
      state: { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] }
    });
    unsubscribe();
    expect(progressLogs.length).toBe(8);
  });

  it('should trigger generic lifecycle hooks in workflow execution', async () => {
    const model = getModelPreset('mock-test');
    model.fauxScript = { text: 'provider stage output', inputTokens: 5, outputTokens: 7 };
    const executedHooks: string[] = [];
    const pipeline = new WorkflowCoordinator({
      model,
      stages: narrativeStages(),
      hooks: [
        {
          onBeforeStage: async ({ stageId, prompt }) => {
            executedHooks.push(`before:${stageId}`);
            return `${prompt} (补充设定)`;
          },
          onAfterStage: async ({ stageId, output }) => {
            executedHooks.push(`after:${stageId}`);
            return `${output}\n【阶段完成】`;
          },
          onStageOutput: async ({ stageId }) => {
            executedHooks.push(`output:${stageId}`);
          }
        }
      ]
    });

    const res = await pipeline.runWorkflow({
      title: '封神记',
      sectionTitle: '第1回',
      input: '开局风云变幻'
    });
    expect(executedHooks).toEqual([
      'before:outline',
      'after:outline',
      'output:outline',
      'before:draft',
      'after:draft',
      'output:draft',
      'before:audit',
      'after:audit',
      'output:audit',
      'before:polish',
      'after:polish',
      'output:polish'
    ]);
    expect(res.outputs.draft).toContain('【阶段完成】');
    expect(res.outputs.polish).toContain('【阶段完成】');
  });
});
