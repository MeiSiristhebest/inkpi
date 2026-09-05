import type { ThinkingLevel } from '@inkpi/protocol';
import { GENERATED_MODELS } from './models.generated.js';
import type { ModelConfig, ProviderType } from './types.js';

export type ModelRole = 'planning' | 'drafting' | 'auditing' | 'polishing';

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: ProviderType | string;
  contextWindow: number;
  maxTokens: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  supportsVision?: boolean;
  /**
   * 是否支持逐轮思考档位（Anthropic 自适应思考 effort）。
   * 生成的目录条目默认不带此标记；可通过 registerModel 显式注入。
   */
  supportsMidConvoEffort?: boolean;
  cost: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    cacheReadPerMillionUsd?: number;
    cacheWritePerMillionUsd?: number;
  };
  description?: string;
  /**
   * Explicit roles this model is recommended for. When present, the catalog
   * manager prefers these over the capability heuristic. Kept optional so
   * generated catalog entries (which carry no role data) still work.
   */
  roles?: ModelRole[];
  /** Explicit preference within a role; higher wins. Defaults to 0. */
  priority?: number;
}

/**
 * Runtime model catalog.
 *
 * Test-only faux entries are deliberately excluded even if an old generated
 * artifact still contains one. This keeps test transport configuration out of
 * production model discovery.
 */
// SAFETY: GENERATED_MODELS entries match ModelCatalogEntry shape from model definitions.
export const KNOWN_MODELS: ModelCatalogEntry[] = (GENERATED_MODELS as unknown as ModelCatalogEntry[]).filter(
  (model) => !isTestOnlyModel(model)
);

function isTestOnlyModel(model: Pick<ModelCatalogEntry, 'id' | 'provider'>): boolean {
  const id = model.id.toLowerCase();
  return model.provider === 'faux' || id === 'mock-model-v1' || id.startsWith('mock/');
}

export function getThinkingBudgetForLevel(level: ThinkingLevel | 'minimal' | 'off' | null | undefined): number {
  switch (level) {
    case 'none':
      return 0;
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 16384;
    case 'xhigh':
      return 24576;
    case 'max':
      return 32768;
    default:
      return 0;
  }
}

/**
 * Explicit canonical aliases. Maps a user-facing alias to the exact catalog id.
 * Replaces the previous substring heuristics (`query.includes('claude-3-7')`
 * etc.) with a declarative, unambiguous mapping.
 */
const CANONICAL_ALIASES: Record<string, string> = {
  'deepseek-reasoner': 'deepseek/deepseek-r1',
  'deepseek/deepseek-reasoner': 'deepseek/deepseek-r1',
  'gpt-6-astra': 'openai/gpt-6-astra',
  'deepseek-v4-flash-vision-exp': 'deepseek/deepseek-v4-flash-vision-exp'
};

export function findModelInCatalog(idOrName: string): ModelCatalogEntry | undefined {
  if (!idOrName) return undefined;
  const query = idOrName.toLowerCase().trim();

  // Resolve explicit canonical aliases without substring guessing.
  const aliased = CANONICAL_ALIASES[query];
  if (aliased) return findModelInCatalog(aliased);

  const normalizedQuery = query.replace(/[./_-\s]/g, '');
  const found = (KNOWN_MODELS || []).find((m) => {
    const mId = (m.id || '').toLowerCase();
    const mName = (m.name || '').toLowerCase();

    if (mId === query || mName === query) return true;
    if (mId.endsWith(`/${query}`)) return true;

    const normId = mId.replace(/[./_-\s]/g, '');
    const normName = mName.replace(/[./_-\s]/g, '');
    return normId.includes(normalizedQuery) || normName.includes(normalizedQuery);
  });

  return found;
}

export function modelCatalogEntryToConfig(entry: ModelCatalogEntry): ModelConfig {
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider as ProviderType,
    supportsThinking: entry.supportsThinking,
    ...(entry.supportsMidConvoEffort !== undefined ? { supportsMidConvoEffort: entry.supportsMidConvoEffort } : {}),
    maxTokens: entry.maxTokens,
    supportsPromptCache: Boolean(entry.cost.cacheReadPerMillionUsd !== undefined)
  };
}

/**
 * 动态模型目录管理器
 */
export class ModelCatalogManager {
  private models = new Map<string, ModelCatalogEntry>();

  constructor(initialModels: ModelCatalogEntry[] = KNOWN_MODELS) {
    for (const m of initialModels) {
      this.models.set(m.id, m);
      const shortId = m.id.includes('/') ? m.id.split('/')[1] : m.id;
      if (shortId && !this.models.has(shortId)) {
        this.models.set(shortId, { ...m, id: shortId });
      }
    }
  }

  public registerModel(entry: ModelCatalogEntry): void {
    this.models.set(entry.id, entry);
  }

  public unregisterModel(id: string): boolean {
    return this.models.delete(id);
  }

  public getModel(id: string): ModelCatalogEntry | undefined {
    return this.models.get(id) || findModelInCatalog(id);
  }

  public getAllModels(): ModelCatalogEntry[] {
    return Array.from(this.models.values());
  }

  public filterByProvider(provider: string): ModelCatalogEntry[] {
    return this.getAllModels().filter((m) => m.provider === provider);
  }

  public filterByCapability(capability: {
    thinking?: boolean;
    tools?: boolean;
    vision?: boolean;
  }): ModelCatalogEntry[] {
    return this.getAllModels().filter((m) => {
      if (capability.thinking !== undefined && m.supportsThinking !== capability.thinking) return false;
      if (capability.tools !== undefined && m.supportsTools !== capability.tools) return false;
      if (capability.vision !== undefined && m.supportsVision !== capability.vision) return false;
      return true;
    });
  }

  /**
   * Explicit per-role preference ordering. Each entry is an exact catalog id
   * (no substring matching); earlier entries win. This replaces the previous
   * `id.includes('mini')` / `id.includes('r1')` heuristics with a curated,
   * unambiguous priority list.
   */
  private static readonly ROLE_PREFERENCES: Record<ModelRole, string[]> = {
    planning: ['deepseek/deepseek-r1', 'anthropic/claude-3.7-sonnet', 'openai/o3-mini', 'google/gemini-2.5-pro'],
    drafting: [
      'deepseek/deepseek-chat',
      'openai/gpt-4o-mini',
      'anthropic/claude-haiku-4.5',
      'deepseek/deepseek-v4-flash'
    ],
    auditing: ['deepseek/deepseek-r1', 'anthropic/claude-3.7-sonnet'],
    polishing: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini']
  };

  private recommend(role: ModelRole): ModelCatalogEntry {
    const all = this.getAllModels();
    const prefs = ModelCatalogManager.ROLE_PREFERENCES[role];
    const qualifies = (m: ModelCatalogEntry): boolean =>
      m.roles?.includes(role) ?? (role === 'planning' ? m.supportsThinking : !m.supportsThinking);
    const candidates = all.filter(qualifies);
    if (candidates.length === 0) return all[0];

    return candidates
      .map((m) => {
        const index = prefs.indexOf(m.id);
        return { entry: m, pref: index === -1 ? Number.POSITIVE_INFINITY : index, priority: m.priority ?? 0 };
      })
      .sort((a, b) => a.pref - b.pref || b.priority - a.priority)[0].entry;
  }

  public getRecommendedPlanningModel(): ModelCatalogEntry {
    return this.recommend('planning');
  }

  public getRecommendedDraftingModel(): ModelCatalogEntry {
    return this.recommend('drafting');
  }

  public routeModelForTask(
    taskType: 'planning' | 'drafting' | 'auditing' | 'polishing',
    overrideModelId?: string
  ): ModelCatalogEntry {
    if (overrideModelId) {
      const found = this.getModel(overrideModelId);
      if (found) return found;
    }

    if (taskType === 'planning' || taskType === 'auditing') {
      return this.getRecommendedPlanningModel();
    }
    return this.getRecommendedDraftingModel();
  }

  public async refreshCatalog(fetcher?: () => Promise<ModelCatalogEntry[]>): Promise<ModelCatalogEntry[]> {
    if (fetcher) {
      const fetched = await fetcher();
      for (const m of fetched) {
        this.models.set(m.id, m);
      }
    }
    return this.getAllModels();
  }
}
