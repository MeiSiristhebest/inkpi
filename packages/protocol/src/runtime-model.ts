import type { JsonObject } from './json.js';
import type { OutputFormat } from './task.js';

/** Model configuration accepted by the Runtime route-management boundary. */
export interface RuntimeModelRegistrationConfig {
  id: string;
  name: string;
  provider: string;
  /** Request-only secret. Runtime never returns it in a route summary. */
  apiKey?: string;
  baseUrl?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  supportsThinking?: boolean;
  supportsMidConvoEffort?: boolean;
  supportsPromptCache?: boolean;
  presencePenalty?: number;
  frequencyPenalty?: number;
  cacheControl?: { type: 'ephemeral' | 'disabled' };
  compat?: JsonObject;
  fauxScript?: JsonObject;
}

/** Public, secret-free model configuration returned by Runtime. */
export interface RuntimeModelSummary {
  id: string;
  name: string;
  provider: string;
  baseUrl?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  supportsThinking?: boolean;
  supportsMidConvoEffort?: boolean;
  supportsPromptCache?: boolean;
  presencePenalty?: number;
  frequencyPenalty?: number;
  cacheControl?: { type: 'ephemeral' | 'disabled' };
}

export type RuntimeModelNetworkCapability = 'offline' | 'optional' | 'required';

export interface RuntimeModelRouteCapabilities {
  /** Provider-native declarations; Runtime transforms are listed separately. */
  nativeCapabilities?: readonly string[];
  runtimeTransforms?: readonly string[];
  capabilities?: readonly string[];
  tools?: readonly string[] | boolean;
  modalities?: readonly string[];
  network?: RuntimeModelNetworkCapability;
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
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  supportsStructuredOutput?: boolean;
  supportsPatchOutput?: boolean;
  supportsStreaming?: boolean;
}

export interface RuntimeModelRouteRanking {
  quality?: number;
  latencyMs?: number;
  costUsd?: number;
  userPreference?: number;
}

/** A route registration sent to Runtime. It may contain an in-memory apiKey. */
export interface RuntimeModelRouteRegistration {
  id: string;
  model: RuntimeModelRegistrationConfig;
  capabilities?: RuntimeModelRouteCapabilities;
  priority?: number;
  ranking?: RuntimeModelRouteRanking;
  fallback?: boolean;
}

/** A route summary returned by Runtime. It never contains credentials. */
export interface RuntimeModelRouteSummary {
  id: string;
  model: RuntimeModelSummary;
  capabilities?: RuntimeModelRouteCapabilities;
  priority?: number;
  ranking?: RuntimeModelRouteRanking;
  fallback?: boolean;
}

export interface RuntimeModelRoutesConfigureParams {
  routes: readonly RuntimeModelRouteRegistration[];
}

export interface RuntimeModelRoutesConfigureResult {
  configured: string[];
  removed: string[];
  routes: RuntimeModelRouteSummary[];
}

export interface RuntimeModelRouteRemoveParams {
  routeId: string;
}

export interface RuntimeModelRouteRemoveResult {
  routeId: string;
  removed: boolean;
  routes: RuntimeModelRouteSummary[];
}

export interface RuntimeModelRouteHealthState {
  availability?: 'available' | 'degraded' | 'unavailable';
  health?: 'healthy' | 'degraded' | 'unhealthy' | 'unknown';
  quota?: { remaining?: number; limit?: number };
  quality?: number;
  latencyMs?: number;
  costUsd?: number;
  userPreference?: number;
}

/** Read-only health query. Health state is owned by Runtime monitors, not RPC callers. */
export interface RuntimeModelRouteHealthParams {
  routeId: string;
}

export interface RuntimeModelRouteHealthResult {
  routeId: string;
  exists: boolean;
  credentialConfigured: boolean;
  state: RuntimeModelRouteHealthState;
  model?: Pick<RuntimeModelSummary, 'id' | 'provider'>;
}
