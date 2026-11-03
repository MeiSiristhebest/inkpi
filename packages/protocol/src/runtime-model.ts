import type { JsonObject } from './json.js';
import type { ThinkingLevel } from './messages.js';
import type { OutputFormat } from './task.js';

/** TTL values exposed by current provider adapters; each provider accepts a subset. */
export type RuntimePromptCacheTtl = '5m' | '30m' | '1h';

export type RuntimeModelCacheControl = { type: 'disabled' } | { type: 'ephemeral'; ttl?: RuntimePromptCacheTtl };

/** Model configuration accepted by the Runtime route-management boundary. */
export interface RuntimeModelRegistrationConfig {
  id: string;
  name: string;
  provider: string;
  /** Opaque reference resolved by the Runtime's host-owned credential broker. */
  credentialRef?: string;
  baseUrl?: string;
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  thinkingBudget?: number;
  reasoningEffort?: ThinkingLevel;
  supportsThinking?: boolean;
  supportsMidConvoEffort?: boolean;
  supportsPromptCache?: boolean;
  presencePenalty?: number;
  frequencyPenalty?: number;
  cacheControl?: RuntimeModelCacheControl;
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
  reasoningEffort?: ThinkingLevel;
  supportsThinking?: boolean;
  supportsMidConvoEffort?: boolean;
  supportsPromptCache?: boolean;
  presencePenalty?: number;
  frequencyPenalty?: number;
  cacheControl?: RuntimeModelCacheControl;
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

/** A route registration sent to Runtime. Credentials are referenced, never included. */
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

/** One-shot provider probe. Credentials are referenced and never returned. */
export interface RuntimeModelProviderProbeParams {
  provider: string;
  baseUrl: string;
  credentialRef?: string;
}

/** Secret-free provider metadata returned alongside model IDs. */
export interface RuntimeModelCatalogEntry {
  id: string;
  name?: string;
  contextTokens?: number;
  maxOutputTokens?: number;
  inputModalities?: string[];
  promptPricePerToken?: string;
  completionPricePerToken?: string;
}

export interface RuntimeModelProviderProbeResult {
  status: number;
  latency: number;
  modelIds: string[];
  catalogModels?: RuntimeModelCatalogEntry[];
}

export interface OpenAIChatGPTPlanAccountSummary {
  accountId: string;
  email?: string;
  name?: string;
  connected: boolean;
  sharing: boolean;
  reauthRequired: boolean;
}

export interface OpenAIChatGPTPlanConnection {
  available: boolean;
  accounts: OpenAIChatGPTPlanAccountSummary[];
}

export interface OpenAIChatGPTPlanSignInParams {
  /** Existing registration to reauthorize; omitted to register another account. */
  accountId?: string;
  enablePlanUsage: boolean;
}

export interface OpenAIChatGPTPlanSignInStart {
  attemptId: string;
  authorizationUrl: string;
}

export interface OpenAIChatGPTPlanSignInStatusParams {
  attemptId: string;
}

export type OpenAIChatGPTPlanSignInStatus =
  | { status: 'pending' }
  | { status: 'connected'; account: OpenAIChatGPTPlanAccountSummary }
  | { status: 'cancelled' | 'error'; message: string };

export interface OpenAIChatGPTPlanModelsParams {
  accountId: string;
}

export interface OpenAIChatGPTPlanModel {
  accountId: string;
  id: string;
  name: string;
}

export interface OpenAIChatGPTPlanDisconnectParams {
  accountId: string;
}

export interface OpenAIChatGPTPlanDisconnectResult {
  accountId: string;
  remoteRevocationConfirmed: boolean;
}

/** Codex account identity and connection state; intentionally separate from ChatGPT Plan. */
export interface OpenAICodexAccountSummary {
  accountId: string;
  email?: string;
  name?: string;
  connected: boolean;
  reauthRequired: boolean;
}

export interface OpenAICodexConnection {
  available: boolean;
  accounts: OpenAICodexAccountSummary[];
}

export interface OpenAICodexSignInParams {
  /** Existing Codex account registration to reauthorize; omitted to add an account. */
  accountId?: string;
}

export interface OpenAICodexSignInStart {
  attemptId: string;
  authorizationUrl: string;
}

export interface OpenAICodexSignInStatusParams {
  attemptId: string;
}

export type OpenAICodexSignInStatus =
  | { status: 'pending' }
  | { status: 'connected'; account: OpenAICodexAccountSummary }
  | { status: 'cancelled' | 'error'; message: string };

export interface OpenAICodexDisconnectParams {
  accountId: string;
}

export interface OpenAICodexDisconnectResult {
  accountId: string;
  remoteRevocationConfirmed: boolean;
}
