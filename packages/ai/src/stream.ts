import type {
  AssistantMessage,
  AssistantMessageEvent,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  Usage
} from '@inkpi/protocol';
import type { EventStream } from './types.js';

export class AssistantEventStream implements EventStream<AssistantMessageEvent> {
  private queue: AssistantMessageEvent[] = [];
  private listeners: Array<(event: AssistantMessageEvent) => void | Promise<void>> = [];
  private listenerPromises = new Set<Promise<void>>();
  private resolvers: Array<(value: IteratorResult<AssistantMessageEvent>) => void> = [];
  private isEnded = false;
  private aborted = false;
  private currentError?: string;

  public push(event: AssistantMessageEvent): void {
    if (this.isEnded || this.aborted) return;
    for (const listener of this.listeners) {
      try {
        const result = listener(event);
        if (result && typeof result.then === 'function') {
          const settled = Promise.resolve(result)
            .catch((err) => {
              console.error('Error in event stream listener:', err);
            })
            .finally(() => {
              this.listenerPromises.delete(settled);
            });
          this.listenerPromises.add(settled);
        }
      } catch (err) {
        console.error('Error in event stream listener:', err);
      }
    }

    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  public error(errorMessage: string): void {
    this.currentError = errorMessage;
    this.push({ type: 'error', error: errorMessage });
    this.end();
  }

  public end(): void {
    if (this.isEnded) return;
    this.isEnded = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver({ value: undefined as any, done: true });
    }
  }

  public abort(): void {
    this.aborted = true;
    this.end();
  }

  public get isAborted(): boolean {
    return this.aborted;
  }

  public on(listener: (event: AssistantMessageEvent) => void | Promise<void>): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  public async waitForListeners(): Promise<void> {
    while (this.listenerPromises.size > 0) {
      await Promise.all([...this.listenerPromises]);
    }
  }

  public [Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    return {
      next: (): Promise<IteratorResult<AssistantMessageEvent>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.isEnded) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<AssistantMessageEvent>>((resolve) => {
          this.resolvers.push(resolve);
        });
      }
    };
  }

  public async collect(): Promise<AssistantMessage> {
    let fullText = '';
    let fullThinking = '';
    const toolCallsMap = new Map<string, { id: string; name: string; argsStr: string; ended: boolean }>();
    let finalUsage: Usage | undefined;
    let hasError = Boolean(this.currentError);
    let errorMessage: string | undefined = this.currentError;

    const fail = (message: string): void => {
      hasError = true;
      errorMessage ||= message;
    };

    for await (const event of this) {
      switch (event.type) {
        case 'text_delta':
          fullText += event.textDelta;
          break;
        case 'thinking_delta':
          fullThinking += event.thinkingDelta;
          break;
        case 'tool_call_start':
          if (!event.toolCallId) {
            fail('Tool call start is missing toolCallId.');
            break;
          }
          if (toolCallsMap.has(event.toolCallId)) {
            fail(`Duplicate tool call start for '${event.toolCallId}'.`);
            break;
          }
          toolCallsMap.set(event.toolCallId, {
            id: event.toolCallId,
            name: event.toolName,
            argsStr: '',
            ended: false
          });
          break;
        case 'tool_call_delta': {
          const item = toolCallsMap.get(event.toolCallId);
          if (!item) {
            fail(`Tool call delta received before start for '${event.toolCallId}'.`);
            break;
          }
          item.argsStr += event.argsDelta;
          break;
        }
        case 'tool_call_end': {
          if (!toolCallsMap.has(event.toolCall.id)) {
            fail(`Tool call end received before start for '${event.toolCall.id}'.`);
            break;
          }
          const existing = toolCallsMap.get(event.toolCall.id)!;
          if (existing.ended) {
            fail(`Duplicate tool call end for '${event.toolCall.id}'.`);
            break;
          }
          let endedArgs = JSON.stringify(event.toolCall.arguments);
          if (existing.argsStr) {
            let partialArguments: unknown;
            try {
              partialArguments = JSON.parse(existing.argsStr);
            } catch {
              partialArguments = undefined;
            }
            if (partialArguments === undefined) {
              endedArgs = existing.argsStr;
            } else if (existing.argsStr !== endedArgs) {
              fail(`Tool call '${event.toolCall.id}' ended with conflicting arguments.`);
              break;
            }
          }
          toolCallsMap.set(event.toolCall.id, {
            id: event.toolCall.id,
            name: event.toolCall.name,
            argsStr: endedArgs,
            ended: true
          });
          break;
        }
        case 'usage':
          finalUsage = { ...event.usage };
          break;
        case 'error':
          hasError = true;
          errorMessage = event.error;
          break;
      }
    }

    const content: (TextContent | ThinkingContent | ToolCallContent)[] = [];

    if (fullThinking.length > 0) {
      content.push({ type: 'thinking', thinking: fullThinking });
    }

    if (fullText.length > 0) {
      content.push({ type: 'text', text: fullText });
    }

    for (const [id, item] of toolCallsMap.entries()) {
      if (!item.name) {
        fail(`Tool call '${id}' is missing a tool name.`);
        continue;
      }
      if (!item.ended) {
        fail(`Tool call '${id}' ended without a tool_call_end event.`);
        continue;
      }
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = item.argsStr ? JSON.parse(item.argsStr) : {};
      } catch {
        fail(`Tool call '${id}' has malformed JSON arguments.`);
        continue;
      }
      if (hasError) continue;
      content.push({
        type: 'toolCall',
        id,
        name: item.name,
        arguments: parsedArgs
      });
    }

    const hasTools = toolCallsMap.size > 0;
    const stopReason = this.aborted ? 'aborted' : hasError ? 'error' : hasTools ? 'tool_use' : 'stop';

    return {
      role: 'assistant',
      content,
      stopReason,
      errorMessage,
      ...(finalUsage ? { usage: finalUsage } : {}),
      timestamp: Date.now()
    };
  }
}

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  signal?: AbortSignal;
}

/**
 * 带指数退避与抖动的可靠 Stream 执行器
 */
function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error('Aborted');
}

/**
 * 可被 AbortSignal 中断的延迟。signal 在等待期间被 abort 时，立即以 abort 错误 reject。
 */
function delayWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function retryAssistantStream<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  let delay = options.initialDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 10000;
  const factor = options.backoffFactor ?? 2;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxRetries) break;
      if (options.signal?.aborted) throw abortError(options.signal);

      const jitter = delay * (0.8 + Math.random() * 0.4);
      options.onRetry?.(attempt, err, jitter);
      try {
        await delayWithSignal(jitter, options.signal);
      } catch (abortErr) {
        lastError = abortErr;
        break;
      }
      delay = Math.min(delay * factor, maxDelay);
    }
  }

  throw lastError;
}

export interface ResilientStreamOptions extends RetryOptions {
  isRetryable?: (error: string) => boolean;
}

/**
 * 弹性流式包装器 (Resilient Stream Wrapper)
 * 遇网络抖动或提供商暂时中断时，自动重试并透明衔接事件流
 */
export function createResilientStream(
  factory: (attempt: number) => AssistantEventStream | Promise<AssistantEventStream>,
  options: ResilientStreamOptions = {}
): AssistantEventStream {
  const outerStream = new AssistantEventStream();
  const maxRetries = options.maxRetries ?? 3;
  let attempt = 0;

  async function runStream(): Promise<void> {
    attempt++;
    let shouldRetry = false;
    let retryError: any = null;

    try {
      const inner = await factory(attempt);
      for await (const event of inner) {
        if (event.type === 'error') {
          const retryable = options.isRetryable ? options.isRetryable(event.error) : true;
          if (retryable && attempt < maxRetries) {
            shouldRetry = true;
            retryError = new Error(event.error);
            break;
          }
        }
        outerStream.push(event);
      }

      if (shouldRetry) {
        const delay = (options.initialDelayMs ?? 50) * (options.backoffFactor ?? 2) ** (attempt - 1);
        options.onRetry?.(attempt, retryError, delay);
        scheduleRetry(delay);
        return;
      }

      outerStream.end();
    } catch (err: any) {
      if (attempt < maxRetries) {
        const delay = (options.initialDelayMs ?? 50) * (options.backoffFactor ?? 2) ** (attempt - 1);
        options.onRetry?.(attempt, err, delay);
        scheduleRetry(delay);
      } else {
        outerStream.error(err?.message || String(err));
      }
    }
  }

  /**
   * 计划一次重试：若已 abort（通过 signal 或 outerStream.abort()），则不再递归，
   * 避免游离递归在重入期间无视 AbortSignal 持续重试。
   */
  function scheduleRetry(delayMs: number): void {
    setTimeout(() => {
      if (options.signal?.aborted || outerStream.isAborted) {
        return;
      }
      void runStream();
    }, delayMs);
  }

  runStream();
  return outerStream;
}
