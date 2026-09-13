import {
  NarrativeSemanticLedgerExtractor,
  RoleRegistry,
  WorkflowCoordinator,
  extractStateLedger
} from '@inkpi/agent-core';
import { getModelPreset } from '@inkpi/ai';
import { formatChineseTypography } from '@inkpi/editor-core';

function narrativeStages() {
  return [
    { id: 'outline', name: '结构大纲规划', role: 'architect' },
    { id: 'draft', name: '正文主创展开', role: 'writer' },
    { id: 'audit', name: '约束与一致性审计', role: 'critic' },
    { id: 'polish', name: '排版校对与润色', role: 'polisher', transformOutput: formatChineseTypography }
  ];
}

function extractLedger(output: string) {
  return extractStateLedger(
    [{ role: 'assistant', content: [{ type: 'text', text: output }] } as any],
    [NarrativeSemanticLedgerExtractor]
  );
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

  it('should execute full 4-stage pipeline with event streaming and state ledger merging', async () => {
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
      ledgerExtractor: extractLedger
    });

    pipeline.subscribe((ev) => {
      events.push(ev.type);
    });

    const result = await pipeline.runWorkflow({
      title: '仙魔道',
      sectionTitle: '第一document 灵脉复苏',
      userPrompt: '主角发现古修遗迹并战胜窥探的杂役弟子',
      stateLedger: {
        entities: [
          { name: 'UserE', status: '练气三层' },
          { name: '老者', status: '神秘' }
        ],
        assets: [{ name: '残破铜镜', owner: 'UserE' }],
        tracks: [],
        locations: [{ name: '青石镇' }],
        modifiedDocuments: ['序document']
      } as any
    });

    expect(events).toContain('stage_start');
    expect(events).toContain('stage_end');
    expect(events).toContain('workflow_complete');

    expect(result.stageOutputs.outline).toBeDefined();
    expect(result.stageOutputs.draft).toBeDefined();
    expect(result.stageOutputs.audit).toBeDefined();
    expect(result.stageOutputs.polish).toBeDefined();
    expect(result.stageLogs.length).toBe(4);

    // Verify Chinese typography was applied by polisher (fullwidth indent)
    expect(result.stageOutputs.polish).toContain('　　');
    expect(result.stateLedger.entities.some((entity) => entity.name === 'First')).toBe(true);
    expect(result.stateLedger.assets.some((asset) => asset.name === 'Key')).toBe(true);
    expect(result.stateLedger.tracks.some((track) => track.clue === 'Archive')).toBe(true);
    expect(result.stateLedger.locations.some((location) => location.name === 'Harbor')).toBe(true);
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
      userPrompt: '测试请求'
    });
    expect(res.stageOutputs.outline).toContain('[Custom architect]');
    expect(res.stageOutputs.draft).toContain('[Custom writer]');
  });

  it('should preserve generic workflow ledger extensions and merge canonical aliases by identity', async () => {
    const coordinator = new WorkflowCoordinator({
      stages: [
        {
          id: 'collect',
          name: 'Collect',
          executor: async () => ({
            text: 'collected',
            modifiedLedger: {
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
            text: `seen:${ctx.stateLedger.entities[0]?.status}`,
            modifiedLedger: {
              entities: [{ id: 'entity-1', name: 'Renamed Again' }],
              modifiedResources: ['resource-3'],
              customExtension: { source: 'finish', preserved: true }
            }
          })
        }
      ]
    });

    const result = await coordinator.runWorkflow({
      userPrompt: 'generic request',
      stateLedger: {
        entities: [{ id: 'entity-1', name: 'Original', status: 'initial' }],
        assets: [{ id: 'asset-1', name: 'Original Asset' }],
        tracks: [{ id: 'track-1', clue: 'existing clue', status: 'pending' }],
        locations: [{ id: 'location-1', name: 'Existing Place' }],
        modifiedResources: ['resource-1'],
        customExtension: { source: 'initial' }
      }
    });

    expect(result.stageOutputs).toEqual({
      collect: 'collected',
      finish: 'seen:updated'
    });
    expect(result.stateLedger.entities).toEqual([{ id: 'entity-1', name: 'Renamed Again', status: 'updated' }]);
    expect(result.stateLedger.assets).toEqual([
      { id: 'asset-1', name: 'Original Asset' },
      { id: 'asset-2', name: 'Added Asset' }
    ]);
    expect(result.stateLedger.tracks).toEqual([
      { id: 'track-1', clue: 'existing clue', status: 'pending' },
      { id: 'track-2', clue: 'new clue', status: 'pending' }
    ]);
    expect(result.stateLedger.locations).toEqual([
      { id: 'location-1', name: 'Existing Place' },
      { id: 'location-2', name: 'New Place' }
    ]);
    expect(result.stateLedger.modifiedResources).toEqual(['resource-1', 'resource-2', 'resource-3']);
    expect(result.stateLedger.customExtension).toEqual({ source: 'finish', preserved: true });
    expect(result.stateLedger).not.toHaveProperty('characters');
    expect(result.stateLedger).not.toHaveProperty('items');
    expect(result.stateLedger).not.toHaveProperty('foreshadowings');
    expect(result.stateLedger).not.toHaveProperty('modifiedDocuments');
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

    const result = await coordinator.runWorkflow({ userPrompt: 'request' });
    expect(before).toEqual(['outline:request']);
    expect(after).toEqual(['outline:raw']);
    expect(outputs).toEqual(['outline:raw [after]']);
    expect(result.stageOutputs.outline).toBe('raw [after]');
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

    await expect(coordinator.runWorkflow({ userPrompt: 'request' })).rejects.toThrow(
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
      userPrompt: '正文开端',
      stateLedger: { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] }
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
      userPrompt: '开局风云变幻'
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
    expect(res.stageOutputs.draft).toContain('【阶段完成】');
    expect(res.stageOutputs.polish).toContain('【阶段完成】');
  });
});
