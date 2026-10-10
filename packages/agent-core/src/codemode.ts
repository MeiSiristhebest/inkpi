import { CodemodeSandbox, MAX_OUTPUT_CHARS, toCodemodeIdentifier } from '@earendil-works/pi-codemode';
import type { CodemodeOutputItem, CodemodeResult } from '@earendil-works/pi-codemode';
import type { AgentTool, ImageContent, TextContent } from '@inkpi/protocol';

export const CODEMODE_TOOL_NAME = 'codemode';

export const CODEMODE_DEFAULTS = Object.freeze({
  timeoutMs: 15_000,
  memoryLimitBytes: 32 * 1024 * 1024,
  maxScriptChars: 64 * 1024,
  maxOutputChars: 64 * 1024,
  maxNestedCalls: 32,
  maxConcurrentNestedCalls: 4,
  maxNestedResultBytes: 32 * 1024,
  maxTimeoutMs: 60_000,
  maxMemoryLimitBytes: 128 * 1024 * 1024
});

export interface CodemodeToolOptions {
  /** Host-configured tools are exposed only when their current registration has exactly `read`. */
  readonly allowedReadTools: readonly string[];
  readonly timeoutMs?: number;
  readonly memoryLimitBytes?: number;
  readonly maxOutputChars?: number;
  /** Overrides the package's worker URL for bundled hosts. */
  readonly workerUrl?: string | URL;
}

export interface CodemodeReadToolDescriptor {
  readonly name: string;
  readonly description: string;
}

export interface CodemodeExecutionContext {
  readonly tools: readonly CodemodeReadToolDescriptor[];
  executeReadTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}

interface CodemodeDispatcherContext {
  readonly codemode?: CodemodeExecutionContext;
}

const codemodeTools = new WeakMap<object, CodemodeToolOptions>();

/** Creates an opt-in model tool. Register it with Agent.getToolRegistry(). */
export function createCodemodeTool(options: CodemodeToolOptions): AgentTool<{ code: string }> {
  const allowedReadTools = [...new Set(options.allowedReadTools.map((name) => name.trim()).filter(Boolean))];
  if (allowedReadTools.length !== options.allowedReadTools.length) {
    throw new Error('Codemode allowedReadTools must contain unique, non-empty names.');
  }
  const identifiers = new Set<string>();
  for (const name of allowedReadTools) {
    const identifier = toCodemodeIdentifier(name);
    if (identifiers.has(identifier)) throw new Error(`Codemode tool names collide at '${identifier}'.`);
    identifiers.add(identifier);
  }
  const timeoutMs = options.timeoutMs ?? CODEMODE_DEFAULTS.timeoutMs;
  const memoryLimitBytes = options.memoryLimitBytes ?? CODEMODE_DEFAULTS.memoryLimitBytes;
  const maxOutputChars = options.maxOutputChars ?? CODEMODE_DEFAULTS.maxOutputChars;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > CODEMODE_DEFAULTS.maxTimeoutMs) {
    throw new RangeError(`Codemode timeoutMs must be between 1 and ${CODEMODE_DEFAULTS.maxTimeoutMs}.`);
  }
  if (
    !Number.isInteger(memoryLimitBytes) ||
    memoryLimitBytes < 1024 * 1024 ||
    memoryLimitBytes > CODEMODE_DEFAULTS.maxMemoryLimitBytes
  ) {
    throw new RangeError(
      `Codemode memoryLimitBytes must be between 1048576 and ${CODEMODE_DEFAULTS.maxMemoryLimitBytes}.`
    );
  }
  if (!Number.isInteger(maxOutputChars) || maxOutputChars <= 0 || maxOutputChars > MAX_OUTPUT_CHARS) {
    throw new RangeError(`Codemode maxOutputChars must be between 1 and ${MAX_OUTPUT_CHARS}.`);
  }

  const tool: AgentTool<{ code: string }> = {
    name: CODEMODE_TOOL_NAME,
    label: 'Code mode',
    description:
      'Run a short JavaScript script in an isolated QuickJS WASM worker. Only allowlisted read tools are available through tools.<name>(args). The script output and return value are returned; nested tool results stay out of conversation history.',
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', minLength: 1, maxLength: CODEMODE_DEFAULTS.maxScriptChars } },
      required: ['code'],
      additionalProperties: false
    },
    replay: 'never',
    implementationVersion: '1',
    async execute(_toolCallId, params, signal, _onUpdate, rawContext) {
      if (typeof params?.code !== 'string' || params.code.length === 0) {
        return errorResult('Codemode requires a non-empty JavaScript script.');
      }
      if (params.code.length > CODEMODE_DEFAULTS.maxScriptChars) {
        return errorResult(`Codemode script exceeds ${CODEMODE_DEFAULTS.maxScriptChars} characters.`);
      }

      const context = (rawContext as CodemodeDispatcherContext | undefined)?.codemode;
      if (!context || typeof context.executeReadTool !== 'function' || !Array.isArray(context.tools)) {
        return errorResult('Codemode must run through the InkPi tool dispatcher.');
      }
      const available = new Map(context.tools.map((entry) => [entry.name, entry]));
      let callCount = 0;
      let activeCalls = 0;
      const tools = allowedReadTools.flatMap((name) => {
        const descriptor = available.get(name);
        if (!descriptor) return [];
        return [
          {
            name,
            description: descriptor.description,
            execute: async (args: unknown, invocation: { signal: AbortSignal }) => {
              callCount += 1;
              if (callCount > CODEMODE_DEFAULTS.maxNestedCalls) {
                throw new Error(`Codemode allows at most ${CODEMODE_DEFAULTS.maxNestedCalls} nested calls.`);
              }
              if (activeCalls >= CODEMODE_DEFAULTS.maxConcurrentNestedCalls) {
                throw new Error(
                  `Codemode allows at most ${CODEMODE_DEFAULTS.maxConcurrentNestedCalls} concurrent nested calls.`
                );
              }
              if (!isPlainJsonObject(args)) throw new Error('Nested tool arguments must be a JSON object.');
              activeCalls += 1;
              try {
                return await context.executeReadTool(name, args, invocation.signal);
              } finally {
                activeCalls -= 1;
              }
            }
          }
        ];
      });

      const sandbox = new CodemodeSandbox({
        tools,
        timeoutMs,
        memoryLimitBytes,
        ...(options.workerUrl !== undefined ? { workerUrl: options.workerUrl } : {})
      });
      let result: CodemodeResult;
      try {
        result = await sandbox.execute(params.code, { signal });
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      } finally {
        await sandbox.close();
      }

      const outputChars = result.output.reduce((total, item) => total + outputLength(item), 0);
      const valueText = result.ok && result.value !== undefined ? safeJson(result.value) : '';
      if (outputChars + valueText.length > maxOutputChars) {
        return errorResult(`Codemode output exceeds ${maxOutputChars} characters.`);
      }

      const content: Array<TextContent | ImageContent> = result.output.map(toAgentContent);
      if (result.ok) {
        if (valueText) content.push({ type: 'text', text: `Return value: ${valueText}` });
        if (content.length === 0) content.push({ type: 'text', text: 'Script completed without output.' });
        return { content, details: { codemode: { nestedCallCount: result.calls.length } } };
      }

      content.push({
        type: 'text',
        text: `Script ${result.error.kind}: ${result.error.message}`
      });
      if (content.length === 0)
        content.push({ type: 'text', text: `Script ${result.error.kind}: ${result.error.message}` });
      return { content, isError: true, details: { codemode: { nestedCallCount: result.calls.length } } };
    }
  };

  codemodeTools.set(tool, {
    allowedReadTools: Object.freeze(allowedReadTools),
    timeoutMs,
    memoryLimitBytes,
    maxOutputChars,
    ...(options.workerUrl !== undefined ? { workerUrl: options.workerUrl } : {})
  });
  return tool;
}

/** Internal dispatcher hook; an arbitrary tool cannot request this context. */
export function getCodemodeToolOptions(tool: AgentTool): CodemodeToolOptions | undefined {
  return codemodeTools.get(tool);
}

function toAgentContent(item: CodemodeOutputItem): TextContent | ImageContent {
  return item.type === 'image'
    ? { type: 'image', image: item.data, mimeType: item.mimeType }
    : { type: 'text', text: item.text };
}

function outputLength(item: CodemodeOutputItem): number {
  return item.type === 'image' ? item.data.length : item.text.length;
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function safeJson(value: unknown): string {
  try {
    const encoded = JSON.stringify(value);
    return encoded === undefined ? '' : encoded;
  } catch {
    return '[return value is not JSON serializable]';
  }
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
