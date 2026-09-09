import { streamAi, type ModelConfig } from '@inkpi/ai';
import type { TaskHandler, TaskHandlerResult } from '@inkpi/agent-core';
import type {
  AgentMessage,
  AssistantMessage,
  TaskOutput,
  ToolCallContent,
} from '@inkpi/protocol';
import type { TaskHandlerContext } from '@inkpi/agent-core';
import type { ToolRegistry } from '@inkpi/agent-core';

export interface TaskModelHandlerOptions {
  model: ModelConfig;
  systemPrompt?: string;
  stream?: typeof streamAi;
  toolRegistry?: ToolRegistry;
  maxToolSteps?: number;
}

/**
 * The single provider boundary for domain-neutral tasks. It returns declared
 * task output only; it never mutates a document or commits a proposal.
 */
export class TaskModelHandler implements TaskHandler {
  readonly id = 'runtime.model';
  readonly kinds = ['*'] as const;
  private readonly model: ModelConfig;
  private readonly systemPrompt: string;
  private readonly stream: typeof streamAi;
  private readonly toolRegistry?: ToolRegistry;
  private readonly maxToolSteps: number;

  constructor(options: TaskModelHandlerOptions) {
    this.model = options.model;
    this.systemPrompt = options.systemPrompt ?? defaultSystemPrompt;
    this.stream = options.stream ?? streamAi;
    this.toolRegistry = options.toolRegistry;
    this.maxToolSteps = Math.max(0, options.maxToolSteps ?? 8);
  }

  getProviderResponseCache(): ProviderResponseCache {
    return this.providerResponseCache;
  }

  async execute(context: TaskHandlerContext): Promise<TaskHandlerResult> {
    const startedAt = Date.now();
    const prompt = buildPrompt(context);
    const messages: AgentMessage[] = [{ role: 'user', content: prompt, timestamp: Date.now() }];
    const toolRegistry = context.toolRegistry ?? this.toolRegistry;
    const toolTrace: Array<{ id: string; name: string; isError: boolean }> = [];
    let assistant: AssistantMessage | undefined;
    let toolStep = 0;
    while (true) {
      const steering = context.consumeSteering();
      if (steering.length > 0) messages.push(publicSteeringMessage(steering));
      assistant = await this.collect(messages, context);
      if (assistant.stopReason === 'error' || assistant.errorMessage) {
        const error = new Error(assistant.errorMessage ?? 'Model returned an error');
        (error as Error & { retryable?: boolean }).retryable = true;
        throw error;
      }
      const toolCalls = assistant.content.filter(isToolCall);
      if (toolCalls.length === 0) break;
      if (++toolStep > this.maxToolSteps) {
        const error = new Error(`Task exceeded the maximum tool steps of ${this.maxToolSteps}`) as Error & { retryable?: boolean };
        error.retryable = false;
        throw error;
      }
      if (!toolRegistry) {
        const error = new Error('Task requested tools but no ToolRegistry is configured') as Error & { retryable?: boolean };
        error.retryable = false;
        throw error;
      }
      messages.push(publicAssistantMessage(assistant));
      context.reportProgress(Math.min(0.9, 0.1 + toolStep / (this.maxToolSteps + 1)));
      const toolResults = await toolRegistry.executeBatch(
        toolCalls,
        'sequential',
        context.signal,
        undefined,
        { taskId: context.task.id, executionRunId: context.executionRunId },
      );
      messages.push(...toolResults);
      for (const result of toolResults) {
        toolTrace.push({ id: result.toolCallId, name: result.toolName, isError: result.isError === true });
      }
    }
    const finalAssistant = assistant;
    if (!finalAssistant) throw new Error('Model returned no assistant message');
    const text = stripPrivateReasoning(finalAssistant.content
      .filter((content): content is { type: 'text'; text: string } => content.type === 'text')
      .map((content) => content.text)
      .join(''));
    const output = parseDeclaredOutput(context.task.outputContract?.format, text);
    context.reportProgress(1);
    return {
      output,
      provenance: {
        provider: this.model.provider,
        model: this.model.id,
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
              instructionVersion: context.instructions.version,
            }
          : {}),
      },
    };
  }

  private async collect(messages: AgentMessage[], context: TaskHandlerContext): Promise<AssistantMessage> {
    const tools = (context.toolRegistry ?? this.toolRegistry)?.getAll().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    const stream = this.stream(this.model, messages, {
      signal: context.signal,
      systemPrompt: this.systemPrompt,
      maxTokens: this.model.maxTokens,
      thinkingBudget: this.model.thinkingBudget,
      ...(tools && tools.length > 0 ? { tools } : {}),
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
    content: assistant.content.filter((content) => content.type === 'text' || content.type === 'toolCall'),
  };
}

function publicSteeringMessage(inputs: unknown[]): AgentMessage {
  return {
    role: 'user',
    content: `Human steering:\n${inputs.map(stableSerialize).join('\n')}`,
    timestamp: Date.now(),
  };
}

function buildPrompt(context: TaskHandlerContext): string {
  const payload = context.task.input.payload;
  const stableInstruction = context.instructions?.entryIds.length
    ? context.instructions.text.trim()
    : '';
  // Backward compatibility only: metadata instruction is accepted for tasks
  // that have no matching InstructionRegistry entry. Registered tasks never
  // receive this dynamic string, which prevents duplicate prompt assembly.
  const fallbackInstruction = !stableInstruction && typeof context.task.metadata?.instruction === 'string'
    ? context.task.metadata.instruction
    : '';
  return [
    `Task kind: ${context.task.kind}`,
    fallbackInstruction ? `Legacy instruction (unregistered task fallback): ${fallbackInstruction}` : '',
    stableInstruction ? `Stable task instruction:\n${stableInstruction}` : '',
    'Return only the declared output format. Do not describe hidden reasoning.',
    `Context:\n${context.context.text}`,
    payload === undefined ? '' : `Task payload:\n${stableSerialize(payload)}`,
    context.checkpoint ? `Resume checkpoint:\n${stableSerialize(context.checkpoint.data)}` : '',
  ].filter(Boolean).join('\n\n');
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

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? '';
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`).join(',')}}`;
}

const defaultSystemPrompt = 'You are InkPi creative intelligence. Follow the task output contract exactly.';
