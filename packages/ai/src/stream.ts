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
  private listeners: Array<(event: AssistantMessageEvent) => void> = [];
  private resolvers: Array<(value: IteratorResult<AssistantMessageEvent>) => void> = [];
  private isEnded = false;
  private aborted = false;
  private currentError?: string;

  public push(event: AssistantMessageEvent): void {
    if (this.isEnded || this.aborted) return;
    for (const listener of this.listeners) {
      try {
        listener(event);
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

  public on(listener: (event: AssistantMessageEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index !== -1) {
        this.listeners.splice(index, 1);
      }
    };
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
    const toolCallsMap = new Map<string, { id: string; name: string; argsStr: string }>();
    let finalUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    let hasError = false;
    let errorMessage: string | undefined = this.currentError;

    for await (const event of this) {
      switch (event.type) {
        case 'text_delta':
          fullText += event.textDelta;
          break;
        case 'thinking_delta':
          fullThinking += event.thinkingDelta;
          break;
        case 'tool_call_start':
          toolCallsMap.set(event.toolCallId, {
            id: event.toolCallId,
            name: event.toolName,
            argsStr: ''
          });
          break;
        case 'tool_call_delta': {
          const item = toolCallsMap.get(event.toolCallId);
          if (item) {
            item.argsStr += event.argsDelta;
          }
          break;
        }
        case 'tool_call_end':
          toolCallsMap.set(event.toolCall.id, {
            id: event.toolCall.id,
            name: event.toolCall.name,
            argsStr: JSON.stringify(event.toolCall.arguments)
          });
          break;
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
      let parsedArgs: Record<string, unknown> = {};
      try {
        parsedArgs = item.argsStr ? JSON.parse(item.argsStr) : {};
      } catch {
        parsedArgs = { raw: item.argsStr };
      }
      content.push({
        type: 'toolCall',
        id,
        name: item.name,
        arguments: parsedArgs
      });
    }

    const hasTools = toolCallsMap.size > 0;
    const stopReason = this.aborted
      ? 'aborted'
      : hasError
      ? 'error'
      : hasTools
      ? 'tool_use'
      : 'stop';

    return {
      role: 'assistant',
      content,
      stopReason,
      errorMessage,
      usage: finalUsage,
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
}

/**
 * 带指数退避与抖动的可靠 Stream 执行器 (1:1 对标 repos/pi retryAssistantCall)
 */
export async function retryAssistantStream<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
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

      const jitter = delay * (0.8 + Math.random() * 0.4);
      options.onRetry?.(attempt, err, jitter);
      await new Promise((res) => setTimeout(res, jitter));
      delay = Math.min(delay * factor, maxDelay);
    }
  }

  throw lastError;
}

