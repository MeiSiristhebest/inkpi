import type { QualityGateRule, StateLedger } from '@inkpi/protocol';

/**
 * Optional, domain-owned gate rules. The generic workflow coordinator does
 * not install these rules; a caller must inject the rules explicitly.
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
      detector: (content, _ledger: StateLedger) =>
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
