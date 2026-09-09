import type { OutputFormat, ThinkingLevel } from '@inkpi/protocol';
import { GENERATED_MODELS } from './models.generated.js';
import type { ModelConfig, ProviderType } from './types.js';

export type ModelRole = 'planning' | 'drafting' | 'auditing' | 'polishing';

export type ModelNetworkMode = 'offline' | 'optional' | 'required';

/**
 * Complete, provider-neutral capability declaration used to build runtime
 * routes. Catalog entries may override these values, but callers should use
 * modelCatalogEntryToCapabilityDeclaration instead of rebuilding the mapping.
 */
export interface ModelCapabilityDeclaration {
  capabilities: readonly string[];
  network: ModelNetworkMode;
  modalities: readonly string[];
  outputFormats: readonly OutputFormat[];
  streaming: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  tools: boolean;
  reasoning: boolean;
  structuredOutput: boolean;
  patchOutput: boolean;
  jsonSchema: boolean;
  promptCaching: boolean;
}

export type ModelCapabilityOverrides = Partial<ModelCapabilityDeclaration>;

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
  /** Optional explicit overrides for the canonical runtime capability matrix. */
  capabilities?: ModelCapabilityOverrides;
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

/**
 * Convert catalog metadata into the one capability contract consumed by the
 * server route builder. Defaults are conservative: catalog metadata proves
 * text output, while structured/patch output requires an explicit override.
 */
export function modelCatalogEntryToCapabilityDeclaration(entry: ModelCatalogEntry): ModelCapabilityDeclaration {
  const configured = entry.capabilities ?? {};
  const declaredFormats: OutputFormat[] = [...new Set<OutputFormat>(configured.outputFormats ?? ['text'])];
  const structuredOutput =
    configured.structuredOutput ?? (configured.jsonSchema === true || declaredFormats.includes('structured'));
  const patchOutput = configured.patchOutput ?? declaredFormats.includes('patch');
  const outputFormats: OutputFormat[] = [
    ...new Set([
      ...declaredFormats,
      ...(structuredOutput ? (['structured'] as const) : []),
      ...(patchOutput ? (['patch'] as const) : [])
    ])
  ];
  const declaration: ModelCapabilityDeclaration = {
    capabilities: [...(configured.capabilities ?? [])],
    network: configured.network ?? (entry.provider === 'ollama' ? 'offline' : 'required'),
    modalities: [...new Set(configured.modalities ?? (entry.supportsVision ? ['text', 'image'] : ['text']))],
    outputFormats,
    streaming: configured.streaming ?? true,
    contextTokens: configured.contextTokens ?? entry.contextWindow,
    maxOutputTokens: configured.maxOutputTokens ?? entry.maxTokens,
    tools: configured.tools ?? entry.supportsTools,
    reasoning: configured.reasoning ?? entry.supportsThinking,
    structuredOutput,
    patchOutput,
    jsonSchema: configured.jsonSchema ?? false,
    promptCaching: configured.promptCaching ?? entry.cost.cacheReadPerMillionUsd !== undefined
  };
  validateModelCapabilityDeclaration(declaration);
  return declaration;
}

/** Validate a fully resolved catalog capability declaration at the boundary. */
export function validateModelCapabilityDeclaration(declaration: ModelCapabilityDeclaration): void {
  if (!['offline', 'optional', 'required'].includes(declaration.network)) {
    throw new Error(`Invalid model network capability: ${String(declaration.network)}`);
  }
  if (declaration.modalities.length === 0 || !declaration.modalities.includes('text')) {
    throw new Error('Model capability declaration must include the text modality');
  }
  if (declaration.outputFormats.length === 0) {
    throw new Error('Model capability declaration must include at least one output format');
  }
  for (const format of declaration.outputFormats) {
    if (!['text', 'structured', 'patch'].includes(format)) {
      throw new Error(`Invalid model output format: ${String(format)}`);
    }
  }
  if (declaration.structuredOutput !== declaration.outputFormats.includes('structured')) {
    throw new Error('Model structuredOutput must agree with outputFormats');
  }
  if (declaration.patchOutput !== declaration.outputFormats.includes('patch')) {
    throw new Error('Model patchOutput must agree with outputFormats');
  }
  if (declaration.jsonSchema && !declaration.structuredOutput) {
    throw new Error('Model jsonSchema support requires structuredOutput support');
  }
  for (const [name, value] of [
    ['contextTokens', declaration.contextTokens],
    ['maxOutputTokens', declaration.maxOutputTokens]
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Model ${name} must be greater than zero`);
  }
  for (const [name, value] of [
    ['streaming', declaration.streaming],
    ['tools', declaration.tools],
    ['reasoning', declaration.reasoning],
    ['structuredOutput', declaration.structuredOutput],
    ['patchOutput', declaration.patchOutput],
    ['jsonSchema', declaration.jsonSchema],
    ['promptCaching', declaration.promptCaching]
  ] as const) {
    if (typeof value !== 'boolean') throw new Error(`Model ${name} must be boolean`);
  }
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
 * 动态别名映射表，支持运行时动态注入与配置覆写（OCP）
 */
const dynamicAliases = new Map<string, string>([
  ['deepseek-reasoner', 'deepseek/deepseek-r1'],
  ['deepseek/deepseek-reasoner', 'deepseek/deepseek-r1'],
  ['gpt-6-astra', 'openai/gpt-6-astra'],
  ['deepseek-v4-flash-vision-exp', 'deepseek/deepseek-v4-flash-vision-exp']
]);

export function registerModelAlias(alias: string, canonicalId: string): void {
  dynamicAliases.set(alias.toLowerCase().trim(), canonicalId);
}

export function findModelInCatalog(idOrName: string): ModelCatalogEntry | undefined {
  if (!idOrName) return undefined;
  const query = idOrName.toLowerCase().trim();

  // Resolve explicit canonical aliases without substring guessing.
  const aliased = dynamicAliases.get(query);
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
  const declaration = modelCatalogEntryToCapabilityDeclaration(entry);
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider as ProviderType,
    supportsThinking: declaration.reasoning,
    ...(entry.supportsMidConvoEffort !== undefined ? { supportsMidConvoEffort: entry.supportsMidConvoEffort } : {}),
    maxTokens: declaration.maxOutputTokens,
    supportsPromptCache: declaration.promptCaching
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
   * 角色偏好排序映射表（支持运行时动态覆盖与自定义注入）
   */
  private rolePreferences: Record<ModelRole, string[]> = {
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

  public setRolePreferences(role: ModelRole, modelIds: string[]): void {
    this.rolePreferences[role] = [...modelIds];
  }

  private recommend(role: ModelRole): ModelCatalogEntry {
    const all = this.getAllModels();
    const prefs = this.rolePreferences[role];
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
