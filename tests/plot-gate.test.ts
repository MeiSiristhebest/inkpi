import { describe, it, expect } from 'vitest';
import {
  NovelCollaborativePipeline,
  type QualityGateIssue
} from '@inkpi/agent-core';

describe('Human-in-the-loop Gate Protocol (Collaborative Pipeline)', () => {
  it('should detect entity destruction and major twists with generic gate rules', () => {
    const pipeline = new NovelCollaborativePipeline({
      customGateRules: [
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

    const pipeline = new NovelCollaborativePipeline({
      enableQualityGate: true,
      customExecutor: async (role) => {
        if (role === 'architect') {
          return '【细纲】核心节点：Bob为掩护主角突围，在强敌围攻中自爆惨烈阵亡！';
        }
        return `[${role}] 生成内容`;
      },
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
    const pipeline = new NovelCollaborativePipeline({
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
});
