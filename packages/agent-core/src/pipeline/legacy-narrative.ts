import { formatChineseTypography } from '@inkpi/editor-core';
import type { QualityGateRule, StateLedger, WorkflowContext, WorkflowStageConfig } from '@inkpi/protocol';
import { formatNovelStateLedger } from '../compaction/state-ledger.js';

/**
 * Narrative rules are an opt-in adapter. The generic coordinator never
 * installs these rules on its own.
 */
export function createNarrativeEntitySafetyRules(): QualityGateRule[] {
  return [
    {
      type: 'entity_elimination',
      severity: 'critical',
      description: '检测到关键实体被消灭/破坏，可能对后续链条造成不可逆破坏。',
      detector: (content, ledger) => {
        const entities = ledger.entities || ledger.characters || [];
        for (const entity of entities) {
          const entityName = entity.name;
          const deathRegex = new RegExp(
            `${entityName}[^。！？\n]*?(?:自爆|惨死|陨落|阵亡|身死道消|被杀|身亡|摧毁|销毁|死亡)`,
            'g'
          );
          if (deathRegex.test(content)) {
            return {
              type: 'entity_death',
              targetEntity: entityName,
              characterOrEntity: entityName,
              entityOrEntity: entityName,
              severity: 'critical',
              description: `检测到关键实体【${entityName}】在当前阶段被消灭/死亡，可能对后续链条造成不可逆破坏。`
            };
          }
        }
        return null;
      }
    },
    {
      type: 'major_twist',
      severity: 'warning',
      pattern: /(?:叛出|背叛|决裂|堕入|血洗|反目成仇|阵营反转)/,
      description: '检测到重大阵营决裂/颠覆性剧情变动，需确认是否符合设计意图。'
    }
  ];
}

/** @deprecated Use createNarrativeEntitySafetyRules explicitly. */
export const createStandardEntitySafetyRules = createNarrativeEntitySafetyRules;

export function createScreenplayGateRules(): QualityGateRule[] {
  return [
    {
      type: 'scene_header_check',
      severity: 'warning',
      pattern: /^(?!(?:INT\.|EXT\.|内景|外景)).*$/m,
      description: '剧本场景未按标准场景标题 (INT./EXT. 或 内景/外景) 规范格式开头。'
    }
  ];
}

export function createShortDramaGateRules(): QualityGateRule[] {
  return [
    {
      type: 'hook_check',
      severity: 'warning',
      description: '短剧前 3 秒黄金吸睛钩子检测',
      detector: (content) =>
        /(?:耳光|退婚|离婚|反击|惊呆|打脸|绝症|重生|神豪|首富|战神|震惊|质问)/.test(content.slice(0, 100))
          ? null
          : {
              type: 'weak_hook',
              severity: 'warning',
              description: '短剧前 3 秒黄金钩子较弱，建议增强开场冲突与吸睛情绪点。'
            }
    }
  ];
}

export function createVisualNovelGateRules(): QualityGateRule[] {
  return [
    {
      type: 'choice_integrity',
      severity: 'warning',
      pattern: /<choice[^>]*>.*?<\/choice>/,
      description: '视觉小说分支选项节点已就绪。'
    }
  ];
}

/**
 * Compatibility workflow retained for callers of runPipeline().
 * New integrations should register their own stages and call runWorkflow().
 */
export function createLegacyNarrativeStages(): WorkflowStageConfig[] {
  return [
    {
      id: 'outline',
      name: '结构大纲规划',
      role: 'architect',
      enableGate: true,
      promptTemplate: (ctx: WorkflowContext) => {
        const ledgerSummary = formatNovelStateLedger(ctx.stateLedger);
        const title = ctx.title || ctx.bookTitle || 'Untitled';
        const section = ctx.sectionTitle || ctx.chapterTitle || 'Untitled';
        return `【创作主题】: ${title} - ${section}\n【指令与要求】: ${ctx.userPrompt}\n【当前状态账本】:\n${ledgerSummary}\n\n请输出结构化大纲与核心节点规划。`;
      }
    },
    {
      id: 'draft',
      name: '正文主创展开',
      role: 'writer',
      promptTemplate: (ctx: WorkflowContext) => {
        const outline = ctx.stageOutputs.outline || ctx.outlineText || ctx.userPrompt;
        const ledgerSummary = formatNovelStateLedger(ctx.stateLedger);
        return `【大纲与依据】:\n${outline}\n\n【状态账本】:\n${ledgerSummary}\n\n请根据大纲展开高质量内容创作。`;
      }
    },
    {
      id: 'audit',
      name: '约束与一致性审计',
      role: 'auditor',
      promptTemplate: (ctx: WorkflowContext) => {
        const draft = ctx.stageOutputs.draft || ctx.draftText || '';
        const ledgerSummary = formatNovelStateLedger(ctx.stateLedger);
        return `【待审内容】:\n${draft}\n\n【状态账本】:\n${ledgerSummary}\n\n请核查生成内容是否符合设定与规则约束，并输出审计结论。`;
      }
    },
    {
      id: 'polish',
      name: '排版校对与润色',
      role: 'polisher',
      promptTemplate: (ctx: WorkflowContext) => {
        const draft = ctx.stageOutputs.draft || ctx.draftText || '';
        const audit = ctx.stageOutputs.audit || '';
        return `【原稿内容】:\n${draft}\n\n【审计反馈】:\n${audit}\n\n请进行规范排版与文字润色。`;
      },
      transformOutput: (output) => formatChineseTypography(output)
    }
  ];
}
