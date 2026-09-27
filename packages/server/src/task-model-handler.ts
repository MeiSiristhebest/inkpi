import {
  ContextBudgetPlanner,
  type RuntimeCacheCoordinatorPort,
  type SessionCompactor,
  type TaskHandler,
  type TaskHandlerContext,
  type TaskHandlerResult,
  type ToolRegistry,
  createExecutionSnapshot,
  createRuntimeCacheKey,
  stableSerialize
} from '@inkpi/agent-core';
import { type ModelConfig, ProviderError, classifyProviderError, streamAi } from '@inkpi/ai';
import {
  type AgentMessage,
  type AssistantMessage,
  type JsonObject,
  type JsonValue,
  type TaskOutput,
  type ToolCallContent,
  assertJsonValue
} from '@inkpi/protocol';
import {
  CapabilityRouter,
  type ModelCapabilities,
  type ModelRoute,
  type ResolvedModelRoute,
  createLegacyDefaultModelCapabilities
} from './model-capability-router.js';
import { ProviderResponseCache, type ProviderResponseCacheOptions } from './provider-response-cache.js';

export {
  CapabilityMismatchError,
  CapabilityRouter,
  createModelRouteFromCatalog
} from './model-capability-router.js';
export type {
  CatalogModelRouteOptions,
  CapabilityMismatchDetails,
  ModelCapabilities,
  ModelRoute,
  ResolvedModelRoute
} from './model-capability-router.js';

export type ProviderRecoveryMode = 'none' | 'retry-same-route' | 'failover-route' | 'compact-and-retry';

export interface ProviderRecoveryOptions {
  mode?: ProviderRecoveryMode;
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
}

/** Bounded provider recovery policy shared by task execution and route failover. */
export class ProviderRecovery {
  readonly mode: ProviderRecoveryMode;
  readonly maxRetries: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  private readonly sleep: (delayMs: number, signal: AbortSignal) => Promise<void>;

  constructor(options: ProviderRecoveryOptions = {}) {
    this.mode = options.mode ?? 'failover-route';
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 1));
    this.initialDelayMs = Math.max(0, Math.floor(options.initialDelayMs ?? 0));
    this.maxDelayMs = Math.max(this.initialDelayMs, Math.floor(options.maxDelayMs ?? 10_000));
    this.sleep =
      options.sleep ??
      ((delayMs, signal) =>
        new Promise((resolve, reject) => {
          if (signal.aborted) {
            reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
            return;
          }
          const timer = setTimeout(resolve, delayMs);
          signal.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
            },
            { once: true }
          );
        }));
  }

  canRetrySameRoute(error: unknown, retriesUsed: number): boolean {
    return this.mode === 'retry-same-route' && retriesUsed < this.maxRetries && isRetryableProviderError(error);
  }

  canFailover(error: unknown): boolean {
    return this.mode === 'failover-route' && isRetryableProviderError(error);
  }

  /** Exposes the bounded action for callers that need to record recovery telemetry. */
  action(error: unknown, retriesUsed: number, hasNextRoute: boolean): ProviderRecoveryMode {
    if (!isRetryableProviderError(error)) return 'none';
    if (this.mode === 'retry-same-route' && retriesUsed < this.maxRetries) return 'retry-same-route';
    if (this.mode === 'compact-and-retry' && retriesUsed === 0) return 'compact-and-retry';
    if (this.mode === 'failover-route' && hasNextRoute) return 'failover-route';
    return 'none';
  }

  async wait(error: unknown, retriesUsed: number, signal: AbortSignal): Promise<void> {
    const normalized = classifyProviderError(error);
    const backoff = this.initialDelayMs * 2 ** retriesUsed;
    const delay = Math.min(normalized.retryAfterMs ?? backoff, normalized.maxDelayMs ?? this.maxDelayMs);
    await this.sleep(delay, signal);
  }
}

export interface TaskModelHandlerOptions {
  model?: ModelConfig;
  systemPrompt?: string;
  stream?: typeof streamAi;
  toolRegistry?: ToolRegistry;
  maxToolSteps?: number;
  routes?: readonly ModelRoute[];
  defaultModelCapabilities?: ModelCapabilities;
  capabilityRouter?: CapabilityRouter;
  providerResponseCache?: ProviderResponseCache;
  providerResponseCacheOptions?: Omit<ProviderResponseCacheOptions, 'cacheCoordinator'>;
  cacheCoordinator?: RuntimeCacheCoordinatorPort;
  /** Optional explicit summarizer capability used for rolling tool-history compaction. */
  sessionCompactor?: SessionCompactor;
  providerRecovery?: ProviderRecoveryOptions;
  contextBudgetPlanner?: ContextBudgetPlanner;
}

/**
 * The single provider boundary for domain-neutral tasks. It returns declared
 * task output only; it never mutates a document or commits a proposal.
 */
export class TaskModelHandler implements TaskHandler {
  readonly id = 'runtime.model';
  readonly kinds = ['*'] as const;
  private readonly systemPrompt: string;
  private readonly stream: typeof streamAi;
  private readonly toolRegistry?: ToolRegistry;
  private readonly maxToolSteps: number;
  private readonly capabilityRouter: CapabilityRouter;
  private readonly providerResponseCache: ProviderResponseCache;
  private readonly sessionCompactor?: SessionCompactor;
  private readonly providerRecovery: ProviderRecovery;
  private readonly contextBudgetPlanner: ContextBudgetPlanner;

  constructor(options: TaskModelHandlerOptions) {
    this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt;
    this.stream = options.stream ?? streamAi;
    this.toolRegistry = options.toolRegistry;
    this.maxToolSteps = Math.max(0, options.maxToolSteps ?? 8);
    this.sessionCompactor = options.sessionCompactor;
    this.providerRecovery = new ProviderRecovery(options.providerRecovery);
    this.contextBudgetPlanner = options.contextBudgetPlanner ?? new ContextBudgetPlanner();
    this.providerResponseCache =
      options.providerResponseCache ??
      new ProviderResponseCache({
        ...options.providerResponseCacheOptions,
        cacheCoordinator: options.cacheCoordinator
      });
    this.capabilityRouter =
      options.capabilityRouter ??
      new CapabilityRouter([
        ...(options.routes ?? []),
        ...(options.model
          ? [
              {
                id: 'default-model',
                model: options.model,
                capabilities: options.defaultModelCapabilities ?? createLegacyDefaultModelCapabilities(options.model),
                fallback: true
              }
            ]
          : [])
      ]);
    if (!options.capabilityRouter && !options.model && (options.routes?.length ?? 0) === 0) {
      throw new Error('TaskModelHandler requires a model, routes, or capabilityRouter');
    }
  }

  getCapabilityRouter(): CapabilityRouter {
    return this.capabilityRouter;
  }

  getProviderResponseCache(): ProviderResponseCache {
    return this.providerResponseCache;
  }

  async execute(context: TaskHandlerContext): Promise<TaskHandlerResult> {
    const routes = this.capabilityRouter.resolveCandidates(context.task);
    if (routes.length === 0) {
      // Preserve the detailed capability mismatch error from the canonical resolver.
      this.capabilityRouter.resolve(context.task);
    }

    const attemptedRoutes: string[] = [];
    let lastError: unknown;
    for (const route of routes) {
      attemptedRoutes.push(route.id);
      let sameRouteRetries = 0;
      while (true) {
        try {
          const result = await this.executeRoute(context, route);
          if (attemptedRoutes.length === 1) return result;
          return {
            ...result,
            provenance: {
              ...result.provenance,
              routeAttempts: attemptedRoutes
            }
          };
        } catch (error) {
          lastError = error;
          if (this.providerRecovery.canRetrySameRoute(error, sameRouteRetries)) {
            sameRouteRetries += 1;
            await this.providerRecovery.wait(error, sameRouteRetries - 1, context.signal);
            continue;
          }
          if (!this.providerRecovery.canFailover(error) || context.signal.aborted) throw error;
          break;
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async executeRoute(context: TaskHandlerContext, route: ResolvedModelRoute): Promise<TaskHandlerResult> {
    const startedAt = Date.now();
    const prompt = buildPrompt(context);
    let messages: AgentMessage[] = [{ role: 'user', content: prompt, timestamp: Date.now() }];
    const toolRegistry =
      route.capabilities.tools === false
        ? undefined
        : (context.toolRegistry ?? route.toolRegistry ?? this.toolRegistry);
    const toolTrace: Array<{ id: string; name: string; isError: boolean }> = [];
    const maxToolSteps = route.maxToolSteps ?? this.maxToolSteps;
    let assistant: AssistantMessage | undefined;
    let toolStep = 0;
    let providerCacheKey: string | undefined;
    let providerCacheHit = false;
    let overflowRecoveryUsed = false;
    while (true) {
      if (this.sessionCompactor) {
        const budgetPlan = this.contextBudgetPlanner.plan(
          {
            contextWindowTokens: route.capabilities.maxContextTokens ?? route.capabilities.contextTokens,
            outputReserveTokens: route.capabilities.maxOutputTokens ?? route.model.maxTokens,
            messages
          },
          this.sessionCompactor
        );
        if (
          (budgetPlan.overBudget || this.sessionCompactor.shouldCompact(messages, context.task)) &&
          messages.length > 1
        ) {
          const compacted = await this.sessionCompactor.compact(messages, context.signal, context.task);
          messages = compacted.compactedMessages;
        }
      }
      const steering = context.consumeSteering();
      if (steering.length > 0) messages.push(publicSteeringMessage(steering));
      const cacheKey =
        toolStep === 0 ? createProviderResponseCacheKey(context, route, messages, this.systemPrompt) : undefined;
      const cached = cacheKey ? this.providerResponseCache.get(cacheKey) : undefined;
      if (cached) {
        assistant = cached;
        providerCacheKey = cacheKey;
        providerCacheHit = true;
      } else {
        assistant = await this.collect(messages, context, route);
        providerCacheKey = cacheKey;
      }
      if (assistant.stopReason === 'error' || assistant.errorMessage) {
        const providerError = assistant.providerError;
        const error = providerError?.code
          ? new ProviderError({
              code: providerError.code as import('@inkpi/ai').ProviderErrorCode,
              message: providerError.message ?? assistant.errorMessage ?? 'Model returned an error',
              retryable: providerError.retryable,
              provider: providerError.provider ?? route.model.provider,
              status: providerError.status,
              retryAfterMs: providerError.retryAfterMs,
              maxDelayMs: providerError.maxDelayMs,
              details: providerError.details
            })
          : new Error(assistant.errorMessage ?? 'Model returned an error');
        if (
          this.sessionCompactor &&
          this.providerRecovery.mode === 'compact-and-retry' &&
          !overflowRecoveryUsed &&
          error instanceof ProviderError &&
          error.code === 'context_overflow'
        ) {
          overflowRecoveryUsed = true;
          const compacted = await this.sessionCompactor.compact(messages, context.signal, context.task);
          messages = compacted.compactedMessages;
          continue;
        }
        throw error;
      }
      const toolCalls = assistant.content.filter(isToolCall);
      if (toolCalls.length === 0) break;
      providerCacheKey = undefined;
      if (++toolStep > maxToolSteps) {
        const error = new Error(`Task exceeded the maximum tool steps of ${maxToolSteps}`) as Error & {
          retryable?: boolean;
        };
        error.retryable = false;
        throw error;
      }
      if (!toolRegistry) {
        const error = new Error('Task requested tools but no ToolRegistry is configured') as Error & {
          retryable?: boolean;
        };
        error.retryable = false;
        throw error;
      }
      messages.push(publicAssistantMessage(assistant));
      context.reportProgress(Math.min(0.9, 0.1 + toolStep / (maxToolSteps + 1)));
      const toolResults = await toolRegistry.executeBatch(toolCalls, 'sequential', context.signal, undefined, {
        taskId: context.task.id,
        executionRunId: context.executionRunId
      });
      messages.push(...toolResults);
      for (const result of toolResults) {
        toolTrace.push({ id: result.toolCallId, name: result.toolName, isError: result.isError === true });
      }
    }
    const finalAssistant = assistant;
    if (!finalAssistant) throw new Error('Model returned no assistant message');
    const text = stripPrivateReasoning(
      finalAssistant.content
        .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
        .map((content) => content.text)
        .join('')
    );
    const output = parseDeclaredOutput(context.task.outputContract?.format, text);
    if (
      providerCacheKey &&
      !providerCacheHit &&
      (finalAssistant.stopReason === undefined || finalAssistant.stopReason === 'stop')
    ) {
      this.providerResponseCache.set(providerCacheKey, finalAssistant, context.context.projectRevision);
    }
    context.reportProgress(1);
    const executionSnapshot = createExecutionSnapshot({
      id: `${context.executionRunId}:attempt:${context.attempt}`,
      taskId: context.task.id,
      createdAt: startedAt,
      model: route.model,
      canonicalModelId: route.model.id,
      systemPrompt: route.systemPrompt ?? this.systemPrompt,
      tools: toolRegistry?.getAll() ?? [],
      messages,
      estimatedTokens: context.context.tokenEstimate,
      policy: executionPolicySnapshot(context.task.executionPolicy),
      metadata: {
        routeId: route.id,
        contextFingerprint: context.context.fingerprint,
        instructionVersion: context.instructions?.version ?? 0,
        ...(context.instructions ? { instructionIds: [...context.instructions.entryIds] } : {})
      }
    });
    return {
      output,
      executionSnapshot,
      provenance: {
        selectedRoute: route.id,
        routeId: route.id,
        selectedProvider: route.model.provider,
        selectedModel: route.model.id,
        provider: route.model.provider,
        model: route.model.id,
        outputFormat: output?.format,
        resultType: output?.format,
        contextFingerprint: context.context.fingerprint,
        contextSources: context.context.fragments.map((fragment) => fragment.source),
        contextTokenCount: context.context.tokenEstimate,
        projectRevision: context.context.projectRevision,
        cacheHit: providerCacheHit,
        providerCacheHit,
        latencyMs: Date.now() - startedAt,
        usage: finalAssistant.usage,
        toolCalls: toolTrace,
        toolStepCount: toolStep,
        ...(context.instructions && context.instructions.entryIds.length > 0
          ? {
              instructionIds: [...context.instructions.entryIds],
              instructionVersion: context.instructions.version
            }
          : {})
      }
    };
  }

  private async collect(
    messages: AgentMessage[],
    context: TaskHandlerContext,
    route: ResolvedModelRoute
  ): Promise<AssistantMessage> {
    const tools =
      route.capabilities.tools === false
        ? undefined
        : (context.toolRegistry ?? route.toolRegistry ?? this.toolRegistry)?.getAll().map((tool) => ({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters
          }));
    const stream = (route.stream ?? this.stream)(route.model, messages, {
      signal: context.signal,
      systemPrompt: route.systemPrompt ?? this.systemPrompt,
      maxTokens: route.model.maxTokens,
      thinkingBudget: route.model.thinkingBudget,
      ...(tools && tools.length > 0 ? { tools } : {})
    });
    const onAbort = () => stream.abort();
    context.signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await stream.collect();
    } finally {
      context.signal.removeEventListener('abort', onAbort);
    }
  }
}

function isToolCall(content: AssistantMessage['content'][number]): content is ToolCallContent {
  return content.type === 'toolCall';
}

function publicAssistantMessage(assistant: AssistantMessage): AssistantMessage {
  return {
    ...assistant,
    content: assistant.content.filter((content) => content.type === 'text' || content.type === 'toolCall')
  };
}

function publicSteeringMessage(inputs: unknown[]): AgentMessage {
  return {
    role: 'user',
    content: `Human steering:\n${inputs.map(stableSerialize).join('\n')}`,
    timestamp: Date.now()
  };
}

function buildPrompt(context: TaskHandlerContext): string {
  const payload = withoutCompiledContext(context.task.input.payload);
  const stableInstruction = context.instructions?.entryIds.length ? context.instructions.text.trim() : '';
  // Backward compatibility only: metadata instruction is accepted for tasks
  // that have no matching InstructionRegistry entry. Registered tasks never
  // receive this dynamic string, which prevents duplicate prompt assembly.
  const fallbackInstruction =
    !stableInstruction && typeof context.task.metadata?.instruction === 'string'
      ? context.task.metadata.instruction
      : '';
  const fragments = context.context.fragments;
  const projectContext = renderFragments(fragments.filter(isStableProjectContext));
  const retrievedContext = renderFragments(
    fragments.filter((fragment) => !isStableProjectContext(fragment) && !isCurrentScene(fragment))
  );
  const currentScene = renderFragments(fragments.filter(isCurrentScene));
  const fallbackContext = fragments.length === 0 ? context.context.text : '';
  const taskDetails = payload === undefined ? '' : stableSerialize(payload);
  const checkpoint = context.checkpoint ? stableSerialize(context.checkpoint.data) : '';
  return [
    `Runtime instruction:\nTask kind: ${context.task.kind}\nReturn only the declared output format. Do not describe hidden reasoning.`,
    stableInstruction ? `Stable skill instruction:\n${stableInstruction}` : '',
    fallbackInstruction ? `Legacy skill instruction fallback:\n${fallbackInstruction}` : '',
    projectContext ? `Stable project context:\n${projectContext}` : '',
    retrievedContext || fallbackContext ? `Retrieved context:\n${retrievedContext || fallbackContext}` : '',
    currentScene ? `Current scene / selection:\n${currentScene}` : '',
    taskDetails ? `Task details:\n${taskDetails}` : '',
    checkpoint ? `Resume checkpoint:\n${checkpoint}` : '',
    context.task.intent?.trim() ? `User intent:\n${context.task.intent.trim()}` : ''
  ]
    .filter(Boolean)
    .join('\n\n');
}

function executionPolicySnapshot(policy: TaskHandlerContext['task']['executionPolicy']): JsonObject | undefined {
  if (!policy) return undefined;
  return {
    ...(policy.strategy !== undefined ? { strategy: policy.strategy } : {}),
    ...(policy.mode !== undefined ? { mode: policy.mode } : {}),
    ...(policy.scheduling !== undefined ? { scheduling: policy.scheduling } : {}),
    ...(policy.priority !== undefined ? { priority: policy.priority } : {}),
    ...(policy.timeoutMs !== undefined ? { timeoutMs: policy.timeoutMs } : {}),
    ...(policy.maxAttempts !== undefined ? { maxAttempts: policy.maxAttempts } : {}),
    ...(policy.cancellable !== undefined ? { cancellable: policy.cancellable } : {}),
    ...(policy.checkpointIntervalMs !== undefined ? { checkpointIntervalMs: policy.checkpointIntervalMs } : {}),
    ...(policy.checkpoint ? { checkpoint: { ...policy.checkpoint } } : {})
  } as JsonObject;
}

function withoutCompiledContext(payload: unknown): JsonValue | undefined {
  if (payload === undefined) return undefined;
  assertJsonValue(payload, 'Task input payload');
  const record = asRecord(payload);
  if (!record || !Object.prototype.hasOwnProperty.call(record, 'context')) return payload;
  const { context: _context, ...copy } = record;
  if (Object.keys(copy).length === 0) return undefined;
  assertJsonValue(copy, 'Task input payload without compiled context');
  return copy;
}

function isStableProjectContext(fragment: TaskHandlerContext['context']['fragments'][number]): boolean {
  return fragment.source === 'creative.story' || fragment.metadata?.contextRole === 'project';
}

function isCurrentScene(fragment: TaskHandlerContext['context']['fragments'][number]): boolean {
  return (
    fragment.source === 'task-input' ||
    fragment.source === 'creative.document' ||
    fragment.source === 'creative.scene' ||
    fragment.metadata?.contextRole === 'scene' ||
    fragment.metadata?.contextRole === 'selection'
  );
}

function renderFragments(fragments: TaskHandlerContext['context']['fragments']): string {
  return fragments
    .map((fragment) => fragment.text ?? renderFragmentValue(fragment.data ?? fragment.content))
    .filter((value) => value.length > 0)
    .join('\n\n');
}

function renderFragmentValue(value: unknown): string {
  if (value === undefined) return '';
  if (typeof value === 'string') return value;
  return stableSerialize(value);
}

function createProviderResponseCacheKey(
  context: TaskHandlerContext,
  route: ResolvedModelRoute,
  messages: AgentMessage[],
  defaultSystemPrompt: string
): string {
  const taskMetadata = asRecord(context.task.metadata);
  const contextMetadata = asRecord(context.task.contextPolicy?.metadata);
  const skillVersion = firstString(taskMetadata?.skillVersion, contextMetadata?.skillVersion);
  return createRuntimeCacheKey({
    layer: 'provider',
    // Provider replies are keyed by the rendered messages too, so the task scope is a
    // sufficient discriminator here; the payload/metadata carriers only matter for the
    // context and retrieval layers, where the resolver supplies them.
    workspaceId: context.task.scope?.workspaceId ?? null,
    taskKind: context.task.kind,
    instructionVersion: context.instructions?.version,
    skillVersion,
    projectRevision: context.context.projectRevision ?? context.task.input.selection?.revision,
    contextFingerprint: context.context.fingerprint,
    provider: route.model.provider,
    model: route.model.id,
    identity: {
      messages: messages.map(messageIdentity),
      outputContract: context.task.outputContract,
      requirements: context.task.requirements,
      routeId: route.id,
      systemPrompt: route.systemPrompt ?? defaultSystemPrompt,
      maxTokens: route.model.maxTokens,
      thinkingBudget: route.model.thinkingBudget,
      contextTruncated: context.context.truncated,
      contextTokenCount: context.context.tokenEstimate
    }
  });
}

function messageIdentity(message: AgentMessage): Record<string, unknown> {
  if (message.role === 'toolResult') {
    return {
      role: message.role,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content,
      details: message.details,
      isError: message.isError
    };
  }
  if (message.role === 'assistant') {
    return {
      role: message.role,
      content: message.content,
      stopReason: message.stopReason,
      providerThinkingLevel: message.providerThinkingLevel
    };
  }
  return { role: message.role, content: message.content };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function parseDeclaredOutput(format: TaskOutput['format'] | undefined, text: string): TaskOutput {
  if (!format || format === 'text') return { format: 'text', text: text.trim() };
  const parsed = parseJson(text);
  if (format === 'patch') return { format: 'patch', patch: parsed };
  return { format: 'structured', data: parsed };
}

function parseJson(text: string): JsonValue {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  try {
    const parsed: unknown = JSON.parse(fenced);
    assertJsonValue(parsed, 'Model JSON output');
    return parsed;
  } catch {
    const error = new Error('Model output is not valid JSON') as Error & { retryable?: boolean };
    error.retryable = false;
    throw error;
  }
}

function stripPrivateReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim();
}

function isRetryableProviderError(error: unknown): boolean {
  return error instanceof ProviderError && error.retryable;
}

const defaultSystemPrompt = 'You are InkPi creative intelligence. Follow the task output contract exactly.';
