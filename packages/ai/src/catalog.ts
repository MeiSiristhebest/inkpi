import type { ThinkingLevel } from '@inkpi/protocol';
import {
  GENERATED_MODELS,
  type GeneratedModelMeta,
  findGeneratedModel,
  listGeneratedModelsByProvider
} from './models.generated.js';
import type { ModelConfig, ProviderType } from './types.js';

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: ProviderType | string;
  contextWindow: number;
  maxTokens: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  supportsVision?: boolean;
  cost: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    cacheReadPerMillionUsd?: number;
    cacheWritePerMillionUsd?: number;
  };
  description?: string;
}

/**
 * Runtime model catalog.
 *
 * Test-only faux entries are deliberately excluded even if an old generated
 * artifact still contains one. This keeps test transport configuration out of
 * production model discovery.
 */
export const KNOWN_MODELS: ModelCatalogEntry[] = (GENERATED_MODELS as unknown as ModelCatalogEntry[]).filter(
  (model) => !isTestOnlyModel(model)
);

function isTestOnlyModel(model: Pick<ModelCatalogEntry, 'id' | 'provider'>): boolean {
  const id = model.id.toLowerCase();
  return model.provider === 'faux' || id === 'mock-model-v1' || id.startsWith('mock/');
}

export function getThinkingBudgetForLevel(level: ThinkingLevel): number {
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

export function findModelInCatalog(idOrName: string): ModelCatalogEntry | undefined {
  if (!idOrName) return undefined;
  const query = idOrName.toLowerCase().trim();
  const normalizedQuery = query.replace(/[./_-\s]/g, '');

  const found = (KNOWN_MODELS || []).find((m) => {
    const mId = (m.id || '').toLowerCase();
    const mName = (m.name || '').toLowerCase();

    if (mId === query || mName === query) return true;
    if (mId.endsWith(`/${query}`)) return true;

    // Canonical Aliases
    if (
      (query === 'deepseek-reasoner' || query === 'deepseek/deepseek-reasoner') &&
      (mId.includes('deepseek-r1') || mId.includes('deepseek/deepseek-r1'))
    )
      return true;
    if (
      (query === 'deepseek-chat' || query === 'deepseek/deepseek-chat') &&
      (mId.includes('deepseek-chat') || mId.includes('deepseek-v3'))
    )
      return true;
    if (query.includes('claude-3-7') && mId.includes('claude-3.7')) return true;
    if (query.includes('claude-3-5') && mId.includes('claude-3.5')) return true;

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

  public getRecommendedPlanningModel(): ModelCatalogEntry {
    const candidates = this.filterByCapability({ thinking: true });
    // Prioritize deepseek-r1, claude-3.7, o3-mini, gemini-2.5-pro
    const preferred = candidates.find(
      (m) => m.id.includes('r1') || m.id.includes('3.7') || m.id.includes('o3') || m.id.includes('gemini-2.5-pro')
    );
    return preferred || candidates[0] || this.getAllModels()[0];
  }

  public getRecommendedDraftingModel(): ModelCatalogEntry {
    const all = this.getAllModels();
    // Prioritize high-throughput cost-effective models (deepseek-chat, gemini-flash, 4o-mini, haiku)
    const preferred = all.find(
      (m) =>
        (m.id.includes('chat') || m.id.includes('flash') || m.id.includes('mini') || m.id.includes('haiku')) &&
        !m.supportsThinking
    );
    return preferred || all[0];
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
