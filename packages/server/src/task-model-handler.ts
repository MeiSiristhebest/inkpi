import {
  type RuntimeCacheCoordinatorPort,
  type TaskHandler,
  type TaskHandlerContext,
  type TaskHandlerResult,
  type ToolRegistry,
  createRuntimeCacheKey,
  stableSerialize
} from '@inkpi/agent-core';
import { type ModelConfig, streamAi } from '@inkpi/ai';
import type { AgentMessage, AssistantMessage, TaskOutput, ToolCallContent } from '@inkpi/protocol';
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

  constructor(options: TaskModelHandlerOptions) {
    this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt;
    this.stream = options.stream ?? streamAi;
    this.toolRegistry = options.toolRegistry;
    this.maxToolSteps = Math.max(0, options.maxToolSteps ?? 8);
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
        if (!shouldFailoverToNextRoute(error, context.signal)) throw error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async executeRoute(context: TaskHandlerContext, route: ResolvedModelRoute): Promise<TaskHandlerResult> {
    const startedAt = Date.now();
    const prompt = buildPrompt(context);
    const messages: AgentMessage[] = [{ role: 'user', content: prompt, timestamp: Date.now() }];
    const toolRegistry = context.toolRegistry ?? route.toolRegistry ?? this.toolRegistry;
    const toolTrace: Array<{ id: string; name: string; isError: boolean }> = [];
    const maxToolSteps = route.maxToolSteps ?? this.maxToolSteps;
    let assistant: AssistantMessage | undefined;
    let toolStep = 0;
    let providerCacheKey: string | undefined;
    let providerCacheHit = false;
    while (true) {
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
        const error = new Error(assistant.errorMessage ?? 'Model returned an error');
        (error as Error & { retryable?: boolean }).retryable = true;
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
    return {
      output,
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
    const tools = (context.toolRegistry ?? route.toolRegistry ?? this.toolRegistry)?.getAll().map((tool) => ({
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

function withoutCompiledContext(payload: unknown): unknown {
  const record = asRecord(payload);
  if (!record || !Object.prototype.hasOwnProperty.call(record, 'context')) return payload;
  const { context: _context, ...copy } = record;
  return Object.keys(copy).length > 0 ? copy : undefined;
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

function messageIdentity(message: AgentMessage): unknown {
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

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  try {
    return JSON.parse(fenced);
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

function shouldFailoverToNextRoute(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted || !(error instanceof Error)) return false;
  return (error as Error & { retryable?: boolean }).retryable === true;
}

const defaultSystemPrompt = 'You are InkPi creative intelligence. Follow the task output contract exactly.';
