import type { StateLedger } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import {
  NarrativeSemanticLedgerExtractor,
  WorkflowCoordinator,
  createScreenplayGateRules,
  createShortDramaGateRules,
  createVisualNovelGateRules,
  extractStateLedger
} from '../packages/agent-core/src/index.js';
import { streamAi } from '../packages/ai/src/index.js';

describe('Multi-Modality Creative Harness & Domain-Agnostic Extensibility Suite', () => {
  // --------------------------------------------------------------------------
  // 1. 影视剧本 (Screenplay Modality)
  // --------------------------------------------------------------------------
  describe('Screenplay Modality (Scene / Dialogue / Stage Direction)', () => {
    it('should coordinate multi-stage screenplay workflow with standard screenplay gate rules', async () => {
      const coordinator = new WorkflowCoordinator({
        stages: [
          { id: 'outline', name: '结构规划', role: 'architect' },
          { id: 'draft', name: '剧本创作', role: 'writer' }
        ],
        customGateRules: createScreenplayGateRules(),
        enableQualityGate: true,
        customExecutor: async (role, _systemPrompt, userPrompt) => {
          if (role === 'architect') {
            return 'SCENE 1: INT. 警局审讯室 - NIGHT\n人物: 陆警官, 嫌疑人陈默\n戏剧冲突: 心理拉锯战';
          }
          if (role === 'writer') {
            return 'INT. 警局审讯室 - NIGHT\n\n一盏昏暗的吊灯在两人头顶轻轻晃动。\n\n陆警官\n（将档案袋重重摔在铁桌上）\n陈默，十二年前北郊废弃化工厂的火灾，你还在撒谎！\n\n陈默\n（缓缓抬起头，嘴角浮现一丝意味深长的微笑）\n警官，真相往往比你想象的更冰冷。';
          }
          return `[${role}] 剧本阶段输出完成: ${userPrompt.slice(0, 20)}`;
        }
      });

      const screenplayLedger: StateLedger = {
        entities: [
          { id: 'char_lu', name: '陆警官', status: '刑侦支队长' },
          { id: 'char_chen', name: '陈默', status: '神秘嫌疑人' }
        ],
        assets: [{ id: 'prop_file', name: '机密档案袋', holder: '陆警官' }],
        tracks: [{ id: 'clue_fire', clue: '十二年前北郊火灾真相', status: 'pending' }],
        locations: [{ name: '警局审讯室' }],
        modifiedResources: ['SCENE_01']
      };

      const result = await coordinator.runWorkflow({
        title: '迷雾追凶 (Film Screenplay)',
        sectionTitle: 'SCENE_01',
        userPrompt: '撰写一场高张力警局审讯开场戏',
        stateLedger: screenplayLedger
      });

      expect(result.stageOutputs.outline).toContain('INT. 警局审讯室');
      expect(result.stageOutputs.draft).toContain('INT. 警局审讯室 - NIGHT');
      expect(result.stageOutputs.draft).toContain('陆警官');
      expect(result.stageOutputs.draft).toContain('陈默');
    });
  });

  // --------------------------------------------------------------------------
  // 2. 短剧分镜 (Short Drama Modality)
  // --------------------------------------------------------------------------
  describe('Short Drama Modality (3-Second Hook / Fast Reversal)', () => {
    it('should detect weak opening hook in short drama and trigger quality gate', () => {
      const coordinator = new WorkflowCoordinator({
        stages: [
          { id: 'outline', name: '分支规划', role: 'architect' },
          { id: 'draft', name: '视觉小说场景', role: 'writer' }
        ],
        customGateRules: createShortDramaGateRules()
      });

      // Weak opening: slow narrative without hook
      const weakOpening = '今天的天气非常晴朗，微风拂过湖面，主人公走在公园的小路上，静静地思考着人生...';
      const issues = coordinator.detectGateIssues(weakOpening);

      expect(issues.length).toBeGreaterThan(0);
      expect(issues[0]?.type).toBe('weak_hook');

      // Strong hook opening
      const strongOpening = '啪！一记响亮的耳光在民政局门口炸响！“顾辰，你一个吃软饭的上门女婿，今天必须离婚！”';
      const strongIssues = coordinator.detectGateIssues(strongOpening);
      expect(strongIssues).toHaveLength(0);
    });
  });

  // --------------------------------------------------------------------------
  // 3. 视觉小说 (Visual Novel Modality)
  // --------------------------------------------------------------------------
  describe('Visual Novel Modality (Branching Choices & Affection Values)', () => {
    it('should parse choice branches and update state ledger variables', async () => {
      const coordinator = new WorkflowCoordinator({
        stages: [
          { id: 'outline', name: '分支规划', role: 'architect' },
          { id: 'draft', name: '视觉小说场景', role: 'writer' }
        ],
        customGateRules: createVisualNovelGateRules(),
        ledgerExtractor: (output) =>
          extractStateLedger(
            [{ role: 'assistant', content: [{ type: 'text', text: output }] } as any],
            [NarrativeSemanticLedgerExtractor]
          ),
        customExecutor: async (role) => {
          if (role === 'writer') {
            return `【背景: 星空下的天台】\n<asset name="红线风铃" holder="女主" />\n少女转过身，微风吹起她的长发。\n\n<choice id="opt_1" target="scene_confession">握住她的手，说出心声</choice>\n<choice id="opt_2" target="scene_silence">默默站在她身边，一同看星空</choice>`;
          }
          return `[${role}] 阶段完成`;
        }
      });

      const vnLedger: StateLedger = {
        entities: [{ id: 'heroine', name: '夏目铃', status: '好感度:80' }],
        assets: [],
        tracks: [{ id: 'flag_confession', clue: '天台告白支线', status: 'pending' }],
        locations: [{ name: '学院天台' }],
        modifiedResources: ['VN_ACT_02']
      };

      const res = await coordinator.runWorkflow({
        title: '星空下的约定 (Visual Novel)',
        sectionTitle: 'VN_ACT_02',
        userPrompt: '设计天台关键选项分支',
        stateLedger: vnLedger
      });

      expect(res.stageOutputs.draft).toContain('<choice id="opt_1"');
      // StateLedger should capture the new asset from XML tags
      expect(res.stateLedger.assets.some((a) => a.name === '红线风铃')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 4. 真实 AI Provider 错误处理 (No Mock / Real Behavior)
  // --------------------------------------------------------------------------
  describe('AI Provider Genuine Execution & Strict Error Boundaries', () => {
    it('should emit explicit error event when real provider is called without API key (zero silent mock fallback)', async () => {
      // Calling OpenAI without API key
      const stream = streamAi(
        {
          id: 'gpt-4o',
          name: 'GPT-4o Real',
          provider: 'openai',
          apiKey: '' // Missing
        },
        [{ role: 'user', content: 'Test prompt', timestamp: Date.now() }]
      );

      const assistantMsg = await stream.collect();

      expect(assistantMsg.stopReason).toBe('error');
      expect(assistantMsg.errorMessage).toContain("Missing API key for provider 'openai'");
    });

    it('should emit explicit error event when Claude provider is called without API key', async () => {
      const stream = streamAi(
        {
          id: 'claude-3-7-sonnet',
          name: 'Claude Real',
          provider: 'claude',
          apiKey: '' // Missing
        },
        [{ role: 'user', content: 'Test prompt', timestamp: Date.now() }]
      );

      const assistantMsg = await stream.collect();

      expect(assistantMsg.stopReason).toBe('error');
      expect(assistantMsg.errorMessage).toContain('Missing API key for Anthropic provider');
    });

    it('should support extended creative roles (screenwriter, storyboarder, script_doctor, worldbuilder, character_designer) with stageHooks', async () => {
      let beforeCalled = false;
      let afterCalled = false;

      const coordinator = new WorkflowCoordinator({
        stages: [
          { id: 'screenplay', name: '剧本创作', role: 'screenwriter' },
          { id: 'storyboard', name: '分镜拆解', role: 'storyboarder' },
          { id: 'review', name: '剧本医生诊断', role: 'script_doctor' }
        ],
        stageHooks: {
          onBeforeStage: async (stageId, ctx, currentPrompt) => {
            beforeCalled = true;
            return `${currentPrompt} [Stage: ${stageId}]`;
          },
          onAfterStage: async (stageId, output, ctx) => {
            afterCalled = true;
            return `${output}\n<!-- End of ${stageId} -->`;
          }
        },
        customExecutor: async (role, systemPrompt, prompt) => {
          return `【${role}输出】: ${prompt}`;
        }
      });

      const res = await coordinator.runWorkflow({
        title: '星际救援',
        userPrompt: '救生舱迫降未知星球'
      });

      expect(beforeCalled).toBe(true);
      expect(afterCalled).toBe(true);
      expect(res.stageOutputs.screenplay).toContain('【screenwriter输出】');
      expect(res.stageOutputs.storyboard).toContain('【storyboarder输出】');
      expect(res.stageOutputs.review).toContain('【script_doctor输出】');
      expect(res.stageOutputs.review).toContain('<!-- End of review -->');
    });
  });
});
