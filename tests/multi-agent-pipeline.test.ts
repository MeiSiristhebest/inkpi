import { WorkflowCoordinator, RoleRegistry } from '@inkpi/agent-core';

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
    const pipeline = new WorkflowCoordinator();

    pipeline.subscribe((ev) => {
      events.push(ev.type);
    });

    const result = await pipeline.runPipeline(
      '仙魔道',
      '第一document 灵脉复苏',
      '主角发现古修遗迹并战胜窥探的杂役弟子',
      {
        entities: [{ name: 'UserE', status: '练气三层' }, { name: '老者', status: '神秘' }],
        assets: [{ name: '残破铜镜', owner: 'UserE' }],
        tracks: [],
        locations: [{ name: '青石镇' }],
        modifiedDocuments: ['序document']
      }
    );


    expect(events).toContain('stage_start');
    expect(events).toContain('stage_end');
    expect(events).toContain('pipeline_complete');

    expect(result.outlineText).toBeDefined();
    expect(result.draftText).toBeDefined();
    expect(result.auditNotes).toBeDefined();
    expect(result.polishedText).toBeDefined();
    expect(result.stageLogs.length).toBe(4);

    // Verify Chinese typography was applied by polisher (fullwidth indent)
    expect(result.polishedText).toContain('　　');
    expect(result.stateLedger.modifiedDocuments).toContain('第一document 灵脉复苏');
  });

  it('should allow custom role executor injection', async () => {
    const pipeline = new WorkflowCoordinator({
      customExecutor: async (role, sysPrompt, userPrompt) => {
        return `[Custom ${role}] executed: ${userPrompt.slice(0, 10)}`;
      }
    });

    const res = await pipeline.runPipeline('workspace名', 'document节', '测试请求');
    expect(res.outlineText).toContain('[Custom architect]');
    expect(res.draftText).toContain('[Custom writer]');
  });

  it('should test progress callback event stream', async () => {
    const pipeline = new WorkflowCoordinator();
    const progressLogs: string[] = [];
    const unsubscribe = pipeline.subscribe((ev) => {
      if (ev.type === 'stage_start' || ev.type === 'stage_end') {
        progressLogs.push(`${ev.type}:${ev.stage}`);
      }
    });

    await pipeline.runPipeline('新workspace', '第一回', '正文开端');
    unsubscribe();
    expect(progressLogs.length).toBe(8);
  });

  it('should trigger all novel hooks in pipeline execution', async () => {
    const executedHooks: string[] = [];
    const pipeline = new WorkflowCoordinator({
      hooks: [
        {
          onBeforeOutline: async ({ userPrompt }) => {
            executedHooks.push('outline');
            return userPrompt + ' (补充设定)';
          },
          onDraftGenerated: async ({ draftText }) => {
            executedHooks.push('draft');
            return draftText + '\n【伏笔埋设完毕】';
          },
          onAuditPass: async () => {
            executedHooks.push('audit');
          },
          onPolishDone: async ({ polishedText }) => {
            executedHooks.push('polish');
            return polishedText + '\n（终稿排版已校）';
          }
        }
      ]
    });

    const res = await pipeline.runPipeline('封神记', '第1回', '开局风云变幻');
    expect(executedHooks).toEqual(['outline', 'draft', 'audit', 'polish']);
    expect(res.draftText).toContain('【伏笔埋设完毕】');
    expect(res.polishedText).toContain('（终稿排版已校）');
  });
});


