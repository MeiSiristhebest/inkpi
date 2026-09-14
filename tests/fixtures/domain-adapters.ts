import type { AgentMessage, QualityGateRule, RuntimeState } from '@inkpi/protocol';
import type { RuntimeStateExtractor } from '../../packages/agent-core/src/compaction/runtime-state.js';

export interface CreativeRuntimeState extends RuntimeState {
  entities: Array<Record<string, unknown>>;
  assets: Array<Record<string, unknown>>;
  tracks: Array<Record<string, unknown>>;
  locations: Array<Record<string, unknown>>;
  modifiedResources: string[];
}

/**
 * Test-only outer-layer adapter. It models the kind of Creative Domain
 * extension that Desktop can inject without putting its rules in agent-core.
 */
export const creativeStateExtractor: RuntimeStateExtractor = {
  id: 'test.creative.state-extractor',
  extract(rawText, context, message) {
    const state = context.state;
    const entities = ensureRecordArray(state, 'entities');
    const assets = ensureRecordArray(state, 'assets');
    const tracks = ensureRecordArray(state, 'tracks');
    const locations = ensureRecordArray(state, 'locations');
    const resources = ensureStringArray(state, 'modifiedResources');

    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue;
        const args = block.arguments;

        if ((block.name === 'update_character' || block.name === 'update_entity') && typeof args.name === 'string') {
          upsert(entities, args.name, {
            name: args.name,
            ...(typeof args.status === 'string' ? { status: args.status } : {}),
            ...(typeof args.affiliation === 'string' ? { affiliation: args.affiliation } : {}),
            ...(typeof args.relationship === 'string' ? { relationship: args.relationship } : {})
          });
        }

        if ((block.name === 'update_item' || block.name === 'update_asset') && typeof args.name === 'string') {
          upsert(assets, args.name, {
            name: args.name,
            ...(typeof args.holder === 'string' ? { holder: args.holder } : {}),
            ...(typeof args.state === 'string' ? { state: args.state } : {})
          });
        }

        if (
          (block.name === 'track_foreshadowing' || block.name === 'track_clue' || block.name === 'track') &&
          typeof (args.clue || args.content) === 'string'
        ) {
          const clue = String(args.clue || args.content);
          upsert(tracks, clue, { clue, status: args.status === 'resolved' ? 'resolved' : 'pending' });
        }

        if (
          (block.name === 'modify_chapter' || block.name === 'modify_document' || block.name === 'modify_resource') &&
          typeof (args.chapterTitle || args.documentTitle || args.title) === 'string'
        ) {
          addUnique(resources, String(args.chapterTitle || args.documentTitle || args.title));
        }
      }
    }

    for (const resource of rawText.match(/(?:doc|res|ch|section|mod|item|scene|act)[_-\w]+/gi) || []) {
      addUnique(resources, resource);
    }

    for (const match of rawText.matchAll(
      /<(?:entity|character)\s+name=["']([^"']+)["'](?:\s+status=["']([^"']+)["'])?[^>]*\/>/gi
    )) {
      upsert(entities, match[1], { name: match[1], ...(match[2] ? { status: match[2] } : {}) });
    }
    for (const match of rawText.matchAll(
      /<(?:asset|item)\s+name=["']([^"']+)["'](?:\s+holder=["']([^"']+)["'])?[^>]*\/>/gi
    )) {
      upsert(assets, match[1], { name: match[1], ...(match[2] ? { holder: match[2] } : {}) });
    }
    for (const match of rawText.matchAll(
      /<track\s+(?:clue|content)=["']([^"']+)["'](?:\s+status=["']([^"']+)["'])?[^>]*\/>/gi
    )) {
      upsert(tracks, match[1], { clue: match[1], status: match[2] === 'resolved' ? 'resolved' : 'pending' });
    }
    for (const match of rawText.matchAll(/<location\s+name=["']([^"']+)["'][^>]*\/>/gi)) {
      upsert(locations, match[1], { name: match[1] });
    }

    state.entities = entities;
    state.assets = assets;
    state.tracks = tracks;
    state.locations = locations;
    state.modifiedResources = resources;
  }
};

export function readCreativeRuntimeState(state: RuntimeState | undefined): CreativeRuntimeState {
  const source = state ?? {};
  return {
    ...source,
    entities: ensureRecordArray(source, 'entities'),
    assets: ensureRecordArray(source, 'assets'),
    tracks: ensureRecordArray(source, 'tracks'),
    locations: ensureRecordArray(source, 'locations'),
    modifiedResources: ensureStringArray(source, 'modifiedResources')
  };
}

export function createNarrativeEntitySafetyRules(): QualityGateRule[] {
  return [
    {
      type: 'entity_elimination',
      severity: 'critical',
      description: '检测到关键实体被消灭/破坏，可能对后续链条造成不可逆破坏。',
      detector: (content, context) => {
        const state = stateFromContext(context);
        const entities = Array.isArray(state.entities) ? state.entities : [];
        for (const entity of entities) {
          if (!isRecord(entity) || typeof entity.name !== 'string') continue;
          const deathRegex = new RegExp(
            `${escapeRegExp(entity.name)}[^。！？\\n]*?(?:自爆|惨死|陨落|阵亡|身死道消|被杀|身亡|摧毁|销毁|死亡)`,
            'g'
          );
          if (deathRegex.test(content)) {
            return {
              type: 'entity_death',
              target: entity.name,
              severity: 'critical' as const,
              description: `检测到关键实体【${entity.name}】在当前阶段被消灭/死亡，可能对后续链条造成不可逆破坏。`
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
      detector: (content) =>
        /(?:耳光|退婚|离婚|反击|惊呆|打脸|绝症|重生|神豪|首富|战神|震惊|质问)/.test(content.slice(0, 100))
          ? null
          : {
              type: 'weak_hook',
              severity: 'warning' as const,
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

function stateFromContext(value: unknown): RuntimeState {
  if (isRecord(value) && isRecord(value.state)) return value.state;
  return isRecord(value) ? value : {};
}

function ensureRecordArray(state: RuntimeState, key: string): Array<Record<string, unknown>> {
  const current = state[key];
  if (Array.isArray(current)) {
    return current.filter(isRecord);
  }
  return [];
}

function ensureStringArray(state: RuntimeState, key: string): string[] {
  const current = state[key];
  return Array.isArray(current) ? current.filter((value): value is string => typeof value === 'string') : [];
}

function upsert(records: Array<Record<string, unknown>>, identity: string, value: Record<string, unknown>): void {
  const index = records.findIndex(
    (record) => record.id === identity || record.name === identity || record.clue === identity
  );
  if (index === -1) records.push(value);
  else records[index] = { ...records[index], ...value };
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
