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

/**
 * Declarative capability requirements used by catalog queries.
 *
 * Array values require every listed value. Scalar capability values are exact
 * matches, while contextTokens and maxOutputTokens are minimum capacities.
 * `thinking` and `vision` remain compatibility aliases for reasoning and the
 * image modality used by the older catalog API.
 */
export type ModelCapabilityFilter = Partial<ModelCapabilityDeclaration> & {
  thinking?: boolean;
  vision?: boolean;
  minContextTokens?: number;
  minimumContext?: number;
  minOutputTokens?: number;
};

/** Provider/model declarations only; this does not probe provider availability. */
export interface DeclaredProviderCapabilityMatrixEntry {
  provider: string;
  modelId: string;
  declaration: ModelCapabilityDeclaration;
}

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
  validateModelCatalogEntry(entry);
  const configured = entry.capabilities ?? {};
  const configuredCapabilities = normalizeStringList(configured.capabilities ?? [], 'Model capabilities');
  const declaredFormats = normalizeStringList(
    configured.outputFormats ?? ['text'],
    'Model output formats'
  ) as OutputFormat[];
  const configuredModalities = normalizeStringList(configured.modalities ?? ['text'], 'Model modalities');
  const structuredOutput =
    configured.structuredOutput ?? (configured.jsonSchema === true || declaredFormats.includes('structured'));
  const patchOutput = configured.patchOutput ?? declaredFormats.includes('patch');
  const outputFormats: OutputFormat[] = [
    ...new Set<OutputFormat>([
      ...declaredFormats,
      ...(structuredOutput ? (['structured'] as const) : []),
      ...(patchOutput ? (['patch'] as const) : [])
    ])
  ];
  const declaration: ModelCapabilityDeclaration = {
    capabilities: configuredCapabilities,
    network: configured.network ?? (entry.provider === 'ollama' ? 'offline' : 'required'),
    modalities:
      configured.modalities === undefined
        ? entry.supportsVision
          ? ['text', 'image']
          : ['text']
        : configuredModalities,
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
  if (!isRecord(declaration)) throw new Error('Model capability declaration must be an object');
  normalizeStringList(declaration.capabilities, 'Model capabilities');
  const modalities = normalizeStringList(declaration.modalities, 'Model modalities');
  if (!['offline', 'optional', 'required'].includes(declaration.network)) {
    throw new Error(`Invalid model network capability: ${String(declaration.network)}`);
  }
  if (modalities.length === 0 || !modalities.includes('text')) {
    throw new Error('Model capability declaration must include the text modality');
  }
  if (!Array.isArray(declaration.outputFormats) || declaration.outputFormats.length === 0) {
    throw new Error('Model capability declaration must include at least one output format');
  }
  for (const format of declaration.outputFormats) {
    if (!['text', 'structured', 'patch'].includes(format as string)) {
      throw new Error(`Invalid model output format: ${String(format)}`);
    }
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
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeStringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item.trim().length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return [...new Set(value as string[])];
}

function validateModelCatalogEntry(entry: ModelCatalogEntry): void {
  if (!isRecord(entry)) throw new Error('Model catalog entry must be an object');
  for (const [name, value] of [
    ['id', entry.id],
    ['name', entry.name],
    ['provider', entry.provider]
  ] as const) {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Model ${name} must be a non-empty string`);
    }
  }
  for (const [name, value] of [
    ['contextWindow', entry.contextWindow],
    ['maxTokens', entry.maxTokens]
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Model ${name} must be greater than zero`);
  }
  for (const [name, value] of [
    ['supportsThinking', entry.supportsThinking],
    ['supportsTools', entry.supportsTools]
  ] as const) {
    if (typeof value !== 'boolean') throw new Error(`Model ${name} must be boolean`);
  }
  for (const [name, value] of [
    ['supportsVision', entry.supportsVision],
    ['supportsMidConvoEffort', entry.supportsMidConvoEffort]
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') throw new Error(`Model ${name} must be boolean`);
  }
  if (entry.priority !== undefined && !Number.isFinite(entry.priority)) {
    throw new Error('Model priority must be finite');
  }
  if (entry.capabilities !== undefined && !isRecord(entry.capabilities)) {
    throw new Error('Model capabilities override must be an object');
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
 * Return a deterministic, provider-grouped view of declared model
 * capabilities. Entries describe catalog metadata only; provider reachability
 * and credentials must be checked by the provider execution layer.
 */
export function getDeclaredProviderCapabilityMatrix(
  entries: readonly ModelCatalogEntry[] = KNOWN_MODELS
): DeclaredProviderCapabilityMatrixEntry[] {
  return entries
    .map((entry) => ({
      provider: entry.provider,
      modelId: entry.id,
      declaration: modelCatalogEntryToCapabilityDeclaration(entry)
    }))
    .sort(
      (left, right) => compareStrings(left.provider, right.provider) || compareStrings(left.modelId, right.modelId)
    );
}

/**
 * 动态模型目录管理器
 */
export class ModelCatalogManager {
  private models = new Map<string, ModelCatalogEntry>();

  constructor(initialModels: ModelCatalogEntry[] = KNOWN_MODELS) {
    for (const m of initialModels) {
      modelCatalogEntryToCapabilityDeclaration(m);
      this.models.set(m.id, m);
      const shortId = m.id.includes('/') ? m.id.split('/')[1] : m.id;
      if (shortId && !this.models.has(shortId)) {
        this.models.set(shortId, { ...m, id: shortId });
      }
    }
  }

  public registerModel(entry: ModelCatalogEntry): void {
    modelCatalogEntryToCapabilityDeclaration(entry);
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

  public filterByCapability(capability: ModelCapabilityFilter = {}): ModelCatalogEntry[] {
    validateModelCapabilityFilter(capability);
    return this.getAllModels().filter((model) => modelMatchesCapabilityFilter(model, capability));
  }

  /** Return capability-compatible models in a stable priority/id order. */
  public rankByCapability(capability: ModelCapabilityFilter = {}): ModelCatalogEntry[] {
    return this.filterByCapability(capability).sort(compareCatalogEntries);
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

  private recommend(role: ModelRole, capability: ModelCapabilityFilter = {}): ModelCatalogEntry {
    const all = this.filterByCapability(capability);
    return this.recommendFromCandidates(role, all);
  }

  private recommendFromCandidates(role: ModelRole, all: ModelCatalogEntry[]): ModelCatalogEntry {
    const prefs = this.rolePreferences[role];
    const qualifies = (m: ModelCatalogEntry): boolean =>
      m.roles?.includes(role) ?? (role === 'planning' ? m.supportsThinking : !m.supportsThinking);
    const roleCandidates = all.filter(qualifies);
    const candidates = roleCandidates.length > 0 ? roleCandidates : all;
    if (candidates.length === 0) {
      throw new Error(`No catalog model satisfies the capability requirements for role '${role}'.`);
    }

    return candidates
      .map((m) => {
        const index = prefs.indexOf(m.id);
        return { entry: m, pref: index === -1 ? Number.POSITIVE_INFINITY : index, priority: m.priority ?? 0 };
      })
      .sort(
        (a, b) =>
          compareNumbers(a.pref, b.pref) ||
          compareNumbers(b.priority, a.priority) ||
          compareCatalogEntries(a.entry, b.entry)
      )[0].entry;
  }

  public getRecommendedPlanningModel(capability: ModelCapabilityFilter = {}): ModelCatalogEntry {
    return this.recommend('planning', capability);
  }

  public getRecommendedDraftingModel(capability: ModelCapabilityFilter = {}): ModelCatalogEntry {
    return this.recommend('drafting', capability);
  }

  public routeModelForTask(
    taskType: 'planning' | 'drafting' | 'auditing' | 'polishing',
    overrideModelId?: string,
    capability: ModelCapabilityFilter = {}
  ): ModelCatalogEntry {
    const candidates = this.filterByCapability(capability);
    if (overrideModelId) {
      const found = this.getModel(overrideModelId);
      if (found && modelMatchesCapabilityFilter(found, capability)) return found;
    }

    const role = taskType === 'planning' || taskType === 'auditing' ? 'planning' : 'drafting';
    return this.recommendFromCandidates(role, candidates);
  }

  public async refreshCatalog(fetcher?: () => Promise<ModelCatalogEntry[]>): Promise<ModelCatalogEntry[]> {
    if (fetcher) {
      const fetched = await fetcher();
      if (!Array.isArray(fetched)) throw new Error('Model catalog refresh must return an array');
      for (const model of fetched) modelCatalogEntryToCapabilityDeclaration(model);
      for (const m of fetched) {
        this.models.set(m.id, m);
      }
    }
    return this.getAllModels();
  }
}

function validateModelCapabilityFilter(filter: ModelCapabilityFilter): void {
  if (!isRecord(filter)) throw new Error('Model capability filter must be an object');
  for (const [name, value] of [
    ['thinking', filter.thinking],
    ['vision', filter.vision],
    ['streaming', filter.streaming],
    ['tools', filter.tools],
    ['reasoning', filter.reasoning],
    ['structuredOutput', filter.structuredOutput],
    ['patchOutput', filter.patchOutput],
    ['jsonSchema', filter.jsonSchema],
    ['promptCaching', filter.promptCaching]
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') throw new Error(`Model filter ${name} must be boolean`);
  }
  if (filter.network !== undefined && !['offline', 'optional', 'required'].includes(filter.network)) {
    throw new Error(`Invalid model filter network capability: ${String(filter.network)}`);
  }
  if (filter.capabilities !== undefined) normalizeStringList(filter.capabilities, 'Model filter capabilities');
  if (filter.modalities !== undefined) normalizeStringList(filter.modalities, 'Model filter modalities');
  if (filter.outputFormats !== undefined) {
    if (!Array.isArray(filter.outputFormats)) throw new Error('Model filter output formats must be an array');
    for (const format of filter.outputFormats) {
      if (!['text', 'structured', 'patch'].includes(format as string)) {
        throw new Error(`Invalid model filter output format: ${String(format)}`);
      }
    }
  }
  for (const [name, value] of [
    ['contextTokens', filter.contextTokens],
    ['maxOutputTokens', filter.maxOutputTokens],
    ['minContextTokens', filter.minContextTokens],
    ['minimumContext', filter.minimumContext],
    ['minOutputTokens', filter.minOutputTokens]
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`Model filter ${name} must be greater than zero`);
    }
  }
}

function modelMatchesCapabilityFilter(entry: ModelCatalogEntry, filter: ModelCapabilityFilter): boolean {
  const declaration = modelCatalogEntryToCapabilityDeclaration(entry);
  if (filter.thinking !== undefined && declaration.reasoning !== filter.thinking) return false;
  if (filter.vision !== undefined && declaration.modalities.includes('image') !== filter.vision) return false;
  if (filter.tools !== undefined && declaration.tools !== filter.tools) return false;
  if (filter.reasoning !== undefined && declaration.reasoning !== filter.reasoning) return false;
  if (filter.streaming !== undefined && declaration.streaming !== filter.streaming) return false;
  if (filter.structuredOutput !== undefined && declaration.structuredOutput !== filter.structuredOutput) return false;
  if (filter.patchOutput !== undefined && declaration.patchOutput !== filter.patchOutput) return false;
  if (filter.jsonSchema !== undefined && declaration.jsonSchema !== filter.jsonSchema) return false;
  if (filter.promptCaching !== undefined && declaration.promptCaching !== filter.promptCaching) return false;
  if (filter.network !== undefined && !supportsNetwork(filter.network, declaration.network)) return false;
  if (filter.capabilities && !supportsAllNamedCapabilities(declaration, filter.capabilities)) return false;
  if (filter.modalities && !includesAll(declaration.modalities, filter.modalities)) return false;
  if (filter.outputFormats && !includesAll(declaration.outputFormats, filter.outputFormats)) return false;

  const minimumContext = Math.max(filter.contextTokens ?? 0, filter.minContextTokens ?? 0, filter.minimumContext ?? 0);
  if (minimumContext > declaration.contextTokens) return false;
  const minimumOutput = Math.max(filter.maxOutputTokens ?? 0, filter.minOutputTokens ?? 0);
  if (minimumOutput > declaration.maxOutputTokens) return false;
  return true;
}

function supportsAllNamedCapabilities(declaration: ModelCapabilityDeclaration, required: readonly string[]): boolean {
  return required.every((value) => {
    if (declaration.capabilities.includes('*') || declaration.capabilities.includes(value)) return true;
    switch (value) {
      case 'text':
        return declaration.modalities.includes('text');
      case 'vision':
      case 'imageInput':
        return declaration.modalities.includes('image');
      case 'thinking':
      case 'reasoning':
        return declaration.reasoning;
      case 'tools':
      case 'toolCalling':
        return declaration.tools;
      case 'structuredOutput':
        return declaration.structuredOutput;
      case 'patchOutput':
        return declaration.patchOutput;
      case 'jsonSchema':
        return declaration.jsonSchema;
      case 'streaming':
        return declaration.streaming;
      case 'promptCaching':
        return declaration.promptCaching;
      default:
        return false;
    }
  });
}

function includesAll(available: readonly string[], required: readonly string[]): boolean {
  return required.every((value) => available.includes('*') || available.includes(value));
}

function supportsNetwork(required: ModelNetworkMode, available: ModelNetworkMode): boolean {
  if (required === 'offline') return available === 'offline';
  if (required === 'optional') return available === 'offline' || available === 'optional' || available === 'required';
  return available === 'required';
}

function compareCatalogEntries(left: ModelCatalogEntry, right: ModelCatalogEntry): number {
  return (
    compareNumbers(right.priority ?? 0, left.priority ?? 0) ||
    compareStrings(left.id, right.id) ||
    compareStrings(left.provider, right.provider) ||
    compareStrings(left.name, right.name)
  );
}

function compareNumbers(left: number, right: number): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function compareStrings(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
