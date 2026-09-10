import type { ToolRegistry } from '@inkpi/agent-core';
import {
  modelCatalogEntryToCapabilityDeclaration,
  modelCatalogEntryToConfig,
  type ModelCatalogEntry,
  type ModelConfig,
  type StreamFn
} from '@inkpi/ai';
import type { AiTask, OutputContract, OutputFormat, TaskRequirements } from '@inkpi/protocol';

export type ModelNetworkCapability = 'offline' | 'optional' | 'required';

export type ModelRouteAvailability = 'available' | 'degraded' | 'unavailable';
export type ModelRouteHealth = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

/** Runtime facts supplied by the provider registry or an application health monitor. */
export interface ModelRouteRuntimeState {
  availability?: ModelRouteAvailability;
  health?: ModelRouteHealth;
  quota?: {
    remaining?: number;
    limit?: number;
  };
  /** Optional live ranking measurements; they override route metadata for one resolution. */
  quality?: number;
  latencyMs?: number;
  costUsd?: number;
  userPreference?: number;
}

/** Deterministic policy metadata. Higher quality/preference and lower latency/cost win. */
export interface ModelRouteRanking {
  quality?: number;
  latencyMs?: number;
  costUsd?: number;
  userPreference?: number;
}

export interface CapabilityRouterOptions {
  /** A snapshot of state keyed by route id. The map/object is read on every resolve. */
  routeStates?: ReadonlyMap<string, ModelRouteRuntimeState> | Readonly<Record<string, ModelRouteRuntimeState>>;
  /** Dynamic state injection. It is evaluated once per route for each resolution. */
  getRouteState?: (route: ResolvedModelRoute, task: AiTask) => ModelRouteRuntimeState | undefined;
}

/** Capabilities declared by an injected model route. */
export interface ModelCapabilities {
  capabilities?: readonly string[];
  tools?: readonly string[] | boolean;
  modalities?: readonly string[];
  network?: ModelNetworkCapability;
  outputFormats?: readonly OutputFormat[];
  streaming?: boolean;
  contextTokens?: number;
  maxLatencyMs?: number;
  maxCostUsd?: number;
  reasoning?: boolean;
  structuredOutput?: boolean;
  patchOutput?: boolean;
  toolCalling?: boolean;
  jsonSchema?: boolean | readonly string[];
  parallelToolCalling?: boolean;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  promptCaching?: boolean;
  schemaIds?: readonly string[];
  /** Compatibility aliases for callers that use capability-oriented names. */
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsStructuredOutput?: boolean;
  supportsPatchOutput?: boolean;
  supportsStreaming?: boolean;
}

/** A model plus its declarative capabilities and optional stream injection. */
export interface ModelRoute {
  id: string;
  model: ModelConfig;
  capabilities?: ModelCapabilities;
  /** Higher values sort first. Fallback routes always sort after non-fallback routes. */
  priority?: number;
  ranking?: ModelRouteRanking;
  fallback?: boolean;
  stream?: StreamFn;
  toolRegistry?: ToolRegistry;
  systemPrompt?: string;
  maxToolSteps?: number;
}

export interface CatalogModelRouteOptions {
  id?: string;
  priority?: number;
  fallback?: boolean;
  stream?: StreamFn;
  toolRegistry?: ToolRegistry;
  systemPrompt?: string;
  maxToolSteps?: number;
  ranking?: ModelRouteRanking;
  /** Route-local overrides for the catalog's canonical declaration. */
  capabilities?: Partial<ModelCapabilities>;
}

/** Build a strict runtime route from the canonical AI model catalog contract. */
export function createModelRouteFromCatalog(
  entry: ModelCatalogEntry,
  options: CatalogModelRouteOptions = {}
): ModelRoute {
  const declaration = modelCatalogEntryToCapabilityDeclaration(entry);
  return {
    id: options.id ?? entry.id,
    model: modelCatalogEntryToConfig(entry),
    capabilities: {
      capabilities: [...declaration.capabilities],
      network: declaration.network,
      modalities: [...declaration.modalities],
      outputFormats: [...declaration.outputFormats],
      streaming: declaration.streaming,
      contextTokens: declaration.contextTokens,
      maxContextTokens: declaration.contextTokens,
      maxOutputTokens: declaration.maxOutputTokens,
      tools: declaration.tools,
      toolCalling: declaration.tools,
      reasoning: declaration.reasoning,
      structuredOutput: declaration.structuredOutput,
      patchOutput: declaration.patchOutput,
      jsonSchema: declaration.jsonSchema,
      promptCaching: declaration.promptCaching,
      ...(options.capabilities ?? {})
    },
    ...(options.priority === undefined ? {} : { priority: options.priority }),
    ...(options.ranking === undefined ? {} : { ranking: { ...options.ranking } }),
    ...(options.fallback === undefined ? {} : { fallback: options.fallback }),
    ...(options.stream === undefined ? {} : { stream: options.stream }),
    ...(options.toolRegistry === undefined ? {} : { toolRegistry: options.toolRegistry }),
    ...(options.systemPrompt === undefined ? {} : { systemPrompt: options.systemPrompt }),
    ...(options.maxToolSteps === undefined ? {} : { maxToolSteps: options.maxToolSteps })
  };
}

export interface ResolvedModelRoute extends ModelRoute {
  id: string;
  capabilities: ModelCapabilities;
}

/**
 * Compatibility capabilities for the legacy single-model Daemon constructor.
 * Callers that provide a capability table still get strict route filtering.
 */
export function createLegacyDefaultModelCapabilities(model: ModelConfig): ModelCapabilities {
  const extended = model as ModelConfig & {
    contextWindow?: number;
    supportsStreaming?: boolean;
    supportsTools?: boolean;
    supportsVision?: boolean;
  };
  const tools = extended.supportsTools ?? true;
  const contextTokens = extended.contextWindow;
  const offline = model.provider === 'ollama' || isLocalUrl(model.baseUrl);
  return {
    capabilities: ['*'],
    tools,
    modalities: extended.supportsVision === true ? ['text', 'image'] : ['text'],
    network: offline ? 'offline' : 'required',
    outputFormats: ['text', 'structured', 'patch'],
    streaming: extended.supportsStreaming ?? true,
    reasoning: model.supportsThinking === true,
    structuredOutput: true,
    patchOutput: true,
    toolCalling: tools,
    jsonSchema: true,
    promptCaching: model.supportsPromptCache === true,
    ...(Number.isFinite(contextTokens) && contextTokens! > 0 ? { contextTokens, maxContextTokens: contextTokens } : {}),
    ...(model.maxTokens === undefined ? {} : { maxOutputTokens: model.maxTokens })
  };
}

export interface CapabilityMismatchDetails {
  taskId: string;
  requirements: TaskRequirements;
  outputContract?: OutputContract;
  routes: Array<{ routeId: string; missing: string[] }>;
}

export class CapabilityMismatchError extends Error {
  readonly code = 'CAPABILITY_MISMATCH';
  readonly details: CapabilityMismatchDetails;

  constructor(details: CapabilityMismatchDetails) {
    const missing = [...new Set(details.routes.flatMap((route) => route.missing))].sort();
    super(
      `Capability mismatch: no model route satisfies task requirements${
        missing.length > 0 ? ` (missing: ${missing.join(', ')})` : ''
      }`
    );
    this.name = 'CapabilityMismatchError';
    this.details = details;
  }
}

/** Deterministic capability filter and route sorter for model-backed tasks. */
const routeOptions = new WeakMap<CapabilityRouter, CapabilityRouterOptions>();

export class CapabilityRouter {
  private readonly routes: ResolvedModelRoute[];

  constructor(routes: readonly ModelRoute[] = [], options: CapabilityRouterOptions = {}) {
    this.routes = routes.map((route) => normalizeRoute(route));
    routeOptions.set(this, options);
    // Keep the original public methods intact while routing new instances
    // through the injected runtime-state evaluator.
    this.resolve = (task) => resolveWithRuntimeState(this, task);
    this.resolveCandidates = (task) => resolveCandidatesWithRuntimeState(this, task);
  }

  list(): ResolvedModelRoute[] {
    return this.routes.map((route) => ({
      ...route,
      capabilities: { ...route.capabilities }
    }));
  }

  resolve(task: AiTask): ResolvedModelRoute {
    const candidates = this.resolveCandidates(task);
    if (candidates.length > 0) return candidates[0];
    const requirements = task.requirements ?? {};
    const evaluations = this.routes.map((route) => ({
      route,
      missing: missingCapabilities(requirements, route.capabilities, task.outputContract)
    }));
    throw new CapabilityMismatchError({
      taskId: task.id,
      requirements,
      outputContract: task.outputContract,
      routes: evaluations.map(({ route, missing }) => ({ routeId: route.id, missing }))
    });
  }

  /** Return all compatible routes in deterministic failover order. */
  resolveCandidates(task: AiTask): ResolvedModelRoute[] {
    const requirements = task.requirements ?? {};
    const hasRequirements = Object.values(requirements).some((value) => {
      if (Array.isArray(value)) return value.length > 0;
      return value !== undefined && value !== false;
    });
    const evaluations = this.routes.map((route) => ({
      route,
      missing: missingCapabilities(requirements, route.capabilities, task.outputContract)
    }));
    const matching = evaluations.filter((evaluation) => evaluation.missing.length === 0);
    const fallbackCandidates = matching.filter((evaluation) => evaluation.route.fallback === true);
    const candidates = (hasRequirements || fallbackCandidates.length === 0 ? matching : fallbackCandidates)
      .filter((evaluation) => evaluation.missing.length === 0)
      .map((evaluation) => evaluation.route)
      .sort(compareRoutes);
    return candidates;
  }
}

function normalizeRoute(route: ModelRoute): ResolvedModelRoute {
  if (!route.id.trim()) throw new Error('Model route id must not be empty');
  const capabilities = route.capabilities ? { ...route.capabilities } : {};
  const model = route.model as ModelConfig & {
    supportsTools?: boolean;
    supportsStreaming?: boolean;
  };
  if (capabilities.reasoning === undefined && capabilities.supportsReasoning === undefined) {
    capabilities.reasoning = model.supportsThinking === true;
  }
  if (
    capabilities.tools === undefined &&
    capabilities.supportsTools === undefined &&
    model.supportsTools !== undefined
  ) {
    capabilities.tools = model.supportsTools;
  }
  if (
    capabilities.streaming === undefined &&
    capabilities.supportsStreaming === undefined &&
    model.supportsStreaming !== undefined
  ) {
    capabilities.streaming = model.supportsStreaming;
  }
  validateRouteCapabilities(route.id, capabilities);
  validateRouteRanking(route.id, route.ranking);
  return { ...route, capabilities };
}

function validateRouteCapabilities(routeId: string, capabilities: ModelCapabilities): void {
  if (capabilities.network !== undefined && !['offline', 'optional', 'required'].includes(capabilities.network)) {
    throw new Error(`Invalid network capability for model route '${routeId}'`);
  }
  for (const format of capabilities.outputFormats ?? []) {
    if (!['text', 'structured', 'patch'].includes(format)) {
      throw new Error(`Invalid output format for model route '${routeId}': ${String(format)}`);
    }
  }
  for (const [name, value] of [
    ['contextTokens', capabilities.contextTokens],
    ['maxContextTokens', capabilities.maxContextTokens],
    ['maxOutputTokens', capabilities.maxOutputTokens]
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`Invalid ${name} for model route '${routeId}'`);
    }
  }
}

function validateRouteRanking(routeId: string, ranking: ModelRouteRanking | undefined): void {
  if (!ranking) return;
  for (const [name, value] of [
    ['quality', ranking.quality],
    ['latencyMs', ranking.latencyMs],
    ['costUsd', ranking.costUsd],
    ['userPreference', ranking.userPreference]
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new Error(`Invalid ${name} ranking for model route '${routeId}'`);
    }
    if (value !== undefined && (name === 'latencyMs' || name === 'costUsd') && value < 0) {
      throw new Error(`Invalid ${name} ranking for model route '${routeId}'`);
    }
  }
}

function validateRuntimeState(routeId: string, state: ModelRouteRuntimeState): void {
  if (state.availability !== undefined && !['available', 'degraded', 'unavailable'].includes(state.availability)) {
    throw new Error(`Invalid availability state for model route '${routeId}'`);
  }
  if (state.health !== undefined && !['healthy', 'degraded', 'unhealthy', 'unknown'].includes(state.health)) {
    throw new Error(`Invalid health state for model route '${routeId}'`);
  }
  for (const [name, value] of [
    ['quota.remaining', state.quota?.remaining],
    ['quota.limit', state.quota?.limit],
    ['quality', state.quality],
    ['latencyMs', state.latencyMs],
    ['costUsd', state.costUsd],
    ['userPreference', state.userPreference]
  ] as const) {
    if (value !== undefined && !Number.isFinite(value)) {
      throw new Error(`Invalid ${name} runtime state for model route '${routeId}'`);
    }
  }
  if (state.quota?.remaining !== undefined && state.quota.remaining < 0) {
    throw new Error(`Invalid quota.remaining runtime state for model route '${routeId}'`);
  }
  if (state.quota?.limit !== undefined && state.quota.limit < 0) {
    throw new Error(`Invalid quota.limit runtime state for model route '${routeId}'`);
  }
  if (state.latencyMs !== undefined && state.latencyMs < 0) {
    throw new Error(`Invalid latencyMs runtime state for model route '${routeId}'`);
  }
  if (state.costUsd !== undefined && state.costUsd < 0) {
    throw new Error(`Invalid costUsd runtime state for model route '${routeId}'`);
  }
}

function readConfiguredRouteState(
  routeStates: CapabilityRouterOptions['routeStates'],
  routeId: string
): ModelRouteRuntimeState | undefined {
  if (!routeStates) return undefined;
  if (typeof (routeStates as ReadonlyMap<string, ModelRouteRuntimeState>).get === 'function') {
    return (routeStates as ReadonlyMap<string, ModelRouteRuntimeState>).get(routeId);
  }
  return (routeStates as Readonly<Record<string, ModelRouteRuntimeState>>)[routeId];
}

function missingRuntimeState(state: ModelRouteRuntimeState | undefined): string[] {
  if (!state) return [];
  const missing: string[] = [];
  if (state.availability === 'unavailable') missing.push('availability:available');
  if (state.health === 'unhealthy') missing.push('health:healthy');
  if (
    state.quota &&
    ((state.quota.remaining !== undefined && state.quota.remaining <= 0) ||
      (state.quota.remaining === undefined && state.quota.limit !== undefined && state.quota.limit <= 0))
  ) {
    missing.push('quota:available');
  }
  return missing;
}

function isLocalUrl(url: string | undefined): boolean {
  return /^(?:https?:\/\/)?(?:localhost|127(?:\.\d{1,3}){3}|::1)(?::\d+)?(?:\/|$)/i.test(url ?? '');
}

function missingCapabilities(
  requirements: TaskRequirements,
  capabilities: ModelCapabilities,
  outputContract?: OutputContract
): string[] {
  const missing: string[] = [];
  addMissingCapabilities(missing, requirements.capabilities, capabilities);
  addMissingValues(
    missing,
    'tool',
    requirements.tools,
    capabilities.tools ?? capabilities.supportsTools ?? capabilities.toolCalling
  );
  addMissingValues(missing, 'modality', requirements.modalities, capabilities.modalities);

  if (requirements.network && !supportsNetwork(requirements.network, capabilities.network)) {
    missing.push(`network:${requirements.network}`);
  }

  const outputFormats = new Set(requirements.outputFormats ?? []);
  if (requirements.needsStructuredOutput) outputFormats.add('structured');
  for (const format of outputFormats) {
    const structured = supportsStructuredOutput(capabilities);
    const patch = supportsPatchOutput(capabilities);
    if (
      !capabilities.outputFormats?.includes(format) &&
      !(format === 'structured' && structured === true) &&
      !(format === 'patch' && patch === true)
    ) {
      missing.push(`outputFormat:${format}`);
    }
  }

  const streaming = capabilities.streaming ?? capabilities.supportsStreaming;
  if ((requirements.streaming === true || requirements.needsStreaming === true) && streaming !== true) {
    missing.push('streaming');
  }

  const tools = capabilities.tools ?? capabilities.supportsTools ?? capabilities.toolCalling;
  if (requirements.needsTools === true && !supportsTools(tools)) missing.push('tools');

  const reasoning = capabilities.reasoning ?? capabilities.supportsReasoning;
  if (requirements.needsReasoning === true && reasoning !== true) missing.push('reasoning');

  const structured = supportsStructuredOutput(capabilities);
  if (
    requirements.needsStructuredOutput &&
    structured !== true &&
    !capabilities.outputFormats?.includes('structured')
  ) {
    missing.push('structuredOutput');
  }

  if (requirements.outputFormats?.includes('patch')) {
    const patch = supportsPatchOutput(capabilities);
    if (patch !== true && !capabilities.outputFormats?.includes('patch')) missing.push('patchOutput');
  }

  const minimumContext = Math.max(requirements.minContextTokens ?? 0, requirements.minimumContext ?? 0);
  const contextTokens = capabilities.contextTokens ?? capabilities.maxContextTokens;
  if (minimumContext > 0 && (contextTokens === undefined || contextTokens < minimumContext)) {
    missing.push(`contextTokens>=${minimumContext}`);
  }
  if (
    requirements.maxLatencyMs !== undefined &&
    (capabilities.maxLatencyMs === undefined || capabilities.maxLatencyMs > requirements.maxLatencyMs)
  ) {
    missing.push(`latency<=${requirements.maxLatencyMs}ms`);
  }
  if (
    requirements.maxCostUsd !== undefined &&
    (capabilities.maxCostUsd === undefined || capabilities.maxCostUsd > requirements.maxCostUsd)
  ) {
    missing.push(`cost<=${requirements.maxCostUsd}usd`);
  }
  if (outputContract) {
    if (!supportsOutputFormat(outputContract.format, capabilities)) {
      missing.push(`outputFormat:${outputContract.format}`);
    }
    if (outputContract.schemaId && !supportsSchema(outputContract.schemaId, capabilities)) {
      missing.push(`schema:${outputContract.schemaId}`);
    }
  }
  return [...new Set(missing)].sort();
}

function addMissingCapabilities(
  missing: string[],
  required: readonly string[] | undefined,
  capabilities: ModelCapabilities
): void {
  if (!required || required.length === 0) return;
  const available = new Set(capabilities.capabilities ?? []);
  for (const value of required) {
    if (available.has('*') || available.has(value) || namedCapability(capabilities, value)) continue;
    missing.push(`capability:${value}`);
  }
}

function addMissingValues(
  missing: string[],
  label: string,
  required: readonly string[] | undefined,
  available: readonly string[] | boolean | undefined
): void {
  if (!required || required.length === 0) return;
  if (available === true) return;
  const values = new Set(Array.isArray(available) ? available : []);
  for (const value of required) {
    if (!values.has('*') && !values.has(value)) missing.push(`${label}:${value}`);
  }
}

function supportsTools(tools: readonly string[] | boolean | undefined): boolean {
  return tools === true || (Array.isArray(tools) && tools.length > 0);
}

function supportsStructuredOutput(capabilities: ModelCapabilities): boolean {
  return (
    capabilities.structuredOutput === true ||
    capabilities.supportsStructuredOutput === true ||
    capabilities.jsonSchema === true ||
    Array.isArray(capabilities.jsonSchema) ||
    (capabilities.schemaIds?.length ?? 0) > 0
  );
}

function supportsPatchOutput(capabilities: ModelCapabilities): boolean {
  return capabilities.patchOutput === true || capabilities.supportsPatchOutput === true;
}

function supportsOutputFormat(format: OutputFormat, capabilities: ModelCapabilities): boolean {
  return (
    capabilities.outputFormats?.includes(format) === true ||
    (format === 'structured' && supportsStructuredOutput(capabilities)) ||
    (format === 'patch' && supportsPatchOutput(capabilities))
  );
}

function supportsSchema(schemaId: string, capabilities: ModelCapabilities): boolean {
  if (capabilities.jsonSchema === true) return true;
  const declared = Array.isArray(capabilities.jsonSchema) ? capabilities.jsonSchema : capabilities.schemaIds;
  return declared?.includes('*') === true || declared?.includes(schemaId) === true;
}

function namedCapability(capabilities: ModelCapabilities, value: string): boolean {
  const flags: Record<string, boolean | undefined> = {
    toolCalling: capabilities.toolCalling ?? capabilities.tools === true,
    jsonSchema: supportsStructuredOutput(capabilities),
    parallelToolCalling: capabilities.parallelToolCalling,
    promptCaching: capabilities.promptCaching,
    reasoning: capabilities.reasoning ?? capabilities.supportsReasoning,
    streaming: capabilities.streaming ?? capabilities.supportsStreaming
  };
  return flags[value] === true;
}

function supportsNetwork(required: ModelNetworkCapability, available: ModelNetworkCapability | undefined): boolean {
  if (required === 'offline') return available === 'offline';
  if (required === 'optional') {
    return available === 'offline' || available === 'optional' || available === 'required';
  }
  return available === 'required';
}

function compareRoutes(left: ResolvedModelRoute, right: ResolvedModelRoute): number {
  if (left.fallback !== right.fallback) return left.fallback ? 1 : -1;
  const priority = (right.priority ?? 0) - (left.priority ?? 0);
  if (priority !== 0) return priority;
  const id = left.id.localeCompare(right.id);
  if (id !== 0) return id;
  const provider = left.model.provider.localeCompare(right.model.provider);
  if (provider !== 0) return provider;
  return left.model.id.localeCompare(right.model.id);
}

interface EvaluatedRoute {
  route: ResolvedModelRoute;
  state?: ModelRouteRuntimeState;
  missing: string[];
}

function resolveWithRuntimeState(router: CapabilityRouter, task: AiTask): ResolvedModelRoute {
  const candidates = resolveCandidatesWithRuntimeState(router, task);
  if (candidates.length > 0) return candidates[0];
  const requirements = task.requirements ?? {};
  const evaluations = evaluateRoutes(router, task);
  throw new CapabilityMismatchError({
    taskId: task.id,
    requirements,
    outputContract: task.outputContract,
    routes: evaluations.map(({ route, missing }) => ({ routeId: route.id, missing }))
  });
}

function resolveCandidatesWithRuntimeState(router: CapabilityRouter, task: AiTask): ResolvedModelRoute[] {
  return evaluateRoutes(router, task)
    .filter((evaluation) => evaluation.missing.length === 0)
    .sort((left, right) => compareEvaluatedRoutes(left, right))
    .map((evaluation) => evaluation.route);
}

function evaluateRoutes(router: CapabilityRouter, task: AiTask): EvaluatedRoute[] {
  const requirements = task.requirements ?? {};
  return router.list().map((route) => {
    const state = getInjectedRouteState(router, route, task);
    return {
      route,
      state,
      missing: [
        ...missingCapabilities(requirements, route.capabilities, task.outputContract),
        ...missingRuntimeState(state)
      ].sort()
    };
  });
}

function getInjectedRouteState(
  router: CapabilityRouter,
  route: ResolvedModelRoute,
  task: AiTask
): ModelRouteRuntimeState | undefined {
  const options = routeOptions.get(router) ?? {};
  const configured = readConfiguredRouteState(options.routeStates, route.id);
  const injected = options.getRouteState?.(route, task);
  if (configured === undefined && injected === undefined) return undefined;
  const state = { ...configured, ...injected };
  validateRuntimeState(route.id, state);
  return state;
}

function compareEvaluatedRoutes(left: EvaluatedRoute, right: EvaluatedRoute): number {
  const availability = compareAvailability(left.state?.availability, right.state?.availability);
  if (availability !== 0) return availability;

  const health = compareHealth(left.state?.health, right.state?.health);
  if (health !== 0) return health;

  const quota = compareDescending(
    left.state?.quota?.remaining ?? Number.POSITIVE_INFINITY,
    right.state?.quota?.remaining ?? Number.POSITIVE_INFINITY
  );
  if (quota !== 0) return quota;

  // Preserve the existing fallback and explicit priority semantics before the
  // finer-grained policy fields are used as tie breakers.
  if (left.route.fallback !== right.route.fallback) return left.route.fallback ? 1 : -1;
  const priority = compareDescending(left.route.priority ?? 0, right.route.priority ?? 0);
  if (priority !== 0) return priority;

  const leftRanking = effectiveRanking(left.route, left.state);
  const rightRanking = effectiveRanking(right.route, right.state);
  const userPreference = compareDescending(leftRanking.userPreference, rightRanking.userPreference);
  if (userPreference !== 0) return userPreference;
  const quality = compareDescending(leftRanking.quality, rightRanking.quality);
  if (quality !== 0) return quality;
  const latency = compareAscending(leftRanking.latencyMs, rightRanking.latencyMs);
  if (latency !== 0) return latency;
  const cost = compareAscending(leftRanking.costUsd, rightRanking.costUsd);
  if (cost !== 0) return cost;

  const id = compareStrings(left.route.id, right.route.id);
  if (id !== 0) return id;
  const provider = compareStrings(left.route.model.provider, right.route.model.provider);
  if (provider !== 0) return provider;
  return compareStrings(left.route.model.id, right.route.model.id);
}

function effectiveRanking(
  route: ResolvedModelRoute,
  state: ModelRouteRuntimeState | undefined
): Required<ModelRouteRanking> {
  return {
    quality: state?.quality ?? route.ranking?.quality ?? 0,
    latencyMs: state?.latencyMs ?? route.ranking?.latencyMs ?? Number.POSITIVE_INFINITY,
    costUsd: state?.costUsd ?? route.ranking?.costUsd ?? Number.POSITIVE_INFINITY,
    userPreference: state?.userPreference ?? route.ranking?.userPreference ?? 0
  };
}

function compareAvailability(
  left: ModelRouteAvailability | undefined,
  right: ModelRouteAvailability | undefined
): number {
  const rank: Record<ModelRouteAvailability, number> = { available: 0, degraded: 1, unavailable: 2 };
  return compareAscending(rank[left ?? 'available'], rank[right ?? 'available']);
}

function compareHealth(left: ModelRouteHealth | undefined, right: ModelRouteHealth | undefined): number {
  const rank: Record<ModelRouteHealth, number> = { healthy: 0, degraded: 1, unknown: 2, unhealthy: 3 };
  return compareAscending(rank[left ?? 'healthy'], rank[right ?? 'healthy']);
}

function compareAscending(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareDescending(left: number, right: number): number {
  if (left === right) return 0;
  return left > right ? -1 : 1;
}

function compareStrings(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
