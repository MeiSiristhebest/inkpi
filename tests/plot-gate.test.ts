import { describe, it, expect } from 'vitest';
import {
  WorkflowCoordinator,
  createStandardEntitySafetyRules,
  createScreenplayGateRules,
  createShortDramaGateRules,
  createVisualNovelGateRules,
  createLegacyNarrativeStages,
  type QualityGateIssue
} from '@inkpi/agent-core';
import type { StateLedger } from '@inkpi/protocol';

const emptyLedger: StateLedger = { entities: [], assets: [], tracks: [], locations: [] };

describe('Human-in-the-loop Gate Protocol (Collaborative Pipeline)', () => {
  it('should detect entity destruction and major twists with generic gate rules', () => {
    const pipeline = new WorkflowCoordinator({
      customGateRules: [
        ...createStandardEntitySafetyRules(),
        {
          type: 'power_escalation',
          pattern: /突飞猛进|连续暴涨|瞬间跃迁/,
          description: '检测到能力/战力数值异常跃迁',
          severity: 'critical'
        }
      ]
    });

    const ledger = {
      entities: [
        { name: 'Alice', status: '活跃' },
        { name: 'Bob', status: '关键导师' }
      ],
      assets: [],
      tracks: [],
      locations: [],
      modifiedDocuments: []
    };

    // 1. Entity destruction detection
    const deathOutline = '在高潮节点，Bob遭遇强敌围攻惨烈阵亡，彻底身死道消！';
    const deathIssues = pipeline.detectQualityGateIssues(deathOutline, ledger);
    expect(deathIssues.some((i) => i.type === 'entity_death')).toBe(true);
    expect(deathIssues.some((i) => i.entityOrEntity === 'Bob')).toBe(true);

    // 2. Custom rule: power escalation
    const powerOutline = 'Alice获得核心权限，能力连续暴涨，瞬间跃迁至最高等级！';
    const powerIssues = pipeline.detectQualityGateIssues(powerOutline, ledger);
    expect(powerIssues.some((i) => i.type === 'power_escalation')).toBe(true);

    // 3. Major twist detection
    const twistOutline = 'Alice发现档案真相，与组织彻底决裂，反戈一击！';
    const twistIssues = pipeline.detectQualityGateIssues(twistOutline, ledger);
    expect(twistIssues.some((i) => i.type === 'major_twist')).toBe(true);
  });

  it('should trigger gate events and allow human interactive approval in pipeline execution', async () => {
    const events: string[] = [];
    let gateTriggered = false;

    const pipeline = new WorkflowCoordinator({
      enableQualityGate: true,
      customExecutor: async (role) => {
        if (role === 'architect') {
          return '【细纲】核心节点：Bob为掩护主角突围，在强敌围攻中自爆惨烈阵亡！';
        }
        return `[${role}] 生成内容`;
      },
      customGateRules: createStandardEntitySafetyRules(),
      qualityGateHandler: async ({ workspaceTitle, documentTitle, issues, outlineText }) => {
        gateTriggered = true;
        expect(issues.length).toBeGreaterThan(0);
        expect(issues[0].type).toBe('entity_death');
        // Author reviews and modifies outline to retain the entity with heavy injuries instead of death
        return {
          approved: true,
          modifiedOutlineText: '【作者微调细纲】Bob虽受重创濒死，但被神秘盟友暗中救走保住一命！',
          feedback: '改动剧情：保留导师角色为后续伏笔'
        };
      }
    });

    pipeline.subscribe((ev) => {
      events.push(ev.type);
    });

    const result = await pipeline.runPipeline(
      '星穹纪元',
      '第40章 突围行动',
      '基地遭遇围攻',
      {
        entities: [{ name: 'Bob', status: '关键导师' }],
        assets: [],
        tracks: [],
        locations: [],
        modifiedDocuments: []
      }
    );

    expect(gateTriggered).toBe(true);
    expect(events).toContain('plot_gate_triggered');
    expect(events).toContain('plot_gate_resolved');
    expect(result.outlineText).toContain('【作者微调细纲】');
    expect(result.qualityGateIssues?.length).toBeGreaterThan(0);
  });

  it('should abort and throw error when author rejects dangerous twist in gate', async () => {
    const pipeline = new WorkflowCoordinator({
      enableQualityGate: true,
      customGateRules: [
        {
          type: 'power_escalation',
          pattern: /无敌天下|数据暴涨/,
          description: '战力异常失衡',
          severity: 'critical'
        }
      ],
      customExecutor: async (role) => {
        if (role === 'architect') {
          return '细纲：主角直接数据暴涨，无敌天下！';
        }
        return '正文';
      },
      qualityGateHandler: async () => {
        return {
          approved: false,
          feedback: '战力膨胀过快，拒绝生成该版本'
        };
      }
    });

    await expect(
      pipeline.runPipeline('测试作品', '第一章', '测试')
    ).rejects.toThrow('门禁未通过');
  });

  it('should evaluate screenplay, short-drama, visual-novel gates and legacy stages templates', () => {
    // 1. Screenplay gates
    const screenplayRules = createScreenplayGateRules();
    expect((screenplayRules[0]!.pattern as RegExp).test('INT. COFFEE SHOP - DAY')).toBe(false);

    // 2. Short-drama hook check
    const shortDramaRules = createShortDramaGateRules();
    const weakHookRes = shortDramaRules[0]!.detector!('今天天气很好，小明走在路上。', emptyLedger);
    expect(weakHookRes?.type).toBe('weak_hook');
    const strongHookRes = shortDramaRules[0]!.detector!('震惊！战神回归，一记耳光打脸前妻！', emptyLedger);
    expect(strongHookRes).toBeNull();

    // 3. Visual novel choice integrity
    const vnRules = createVisualNovelGateRules();
    expect((vnRules[0]!.pattern as RegExp).test('<choice id="1">Go Left</choice>')).toBe(true);

    // 4. Legacy narrative stages prompts
    const stages = createLegacyNarrativeStages();
    expect(stages.length).toBe(4);
    const mockCtx = {
      userPrompt: '测试指令',
      title: '书名',
      sectionTitle: '章节名',
      stageOutputs: { outline: '大纲', draft: '正文', audit: '合规' },
      stateLedger: emptyLedger
    };
    expect(stages[0]!.promptTemplate!(mockCtx)).toContain('书名 - 章节名');
    expect(stages[1]!.promptTemplate!(mockCtx)).toContain('大纲');
    expect(stages[2]!.promptTemplate!(mockCtx)).toContain('正文');
    expect(stages[3]!.promptTemplate!(mockCtx)).toContain('合规');
    expect(stages[3]!.transformOutput!('原文本', mockCtx)).toBeDefined();
  });
});
