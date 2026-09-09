import type { ToolRegistry } from '@inkpi/agent-core';
import type { ModelConfig, StreamFn } from '@inkpi/ai';
import type { AiTask, OutputContract, OutputFormat, TaskRequirements } from '@inkpi/protocol';

export type ModelNetworkCapability = 'offline' | 'optional' | 'required';

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
  fallback?: boolean;
  stream?: StreamFn;
  toolRegistry?: ToolRegistry;
  systemPrompt?: string;
  maxToolSteps?: number;
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
export class CapabilityRouter {
  private readonly routes: ResolvedModelRoute[];

  constructor(routes: readonly ModelRoute[] = []) {
    this.routes = routes.map((route) => normalizeRoute(route));
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
  return { ...route, capabilities };
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
  if (required === 'optional') return available === 'optional' || available === 'required';
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
