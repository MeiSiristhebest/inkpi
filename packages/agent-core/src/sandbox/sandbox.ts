/**
 * 基于 `node:vm` 的可信计算辅助工具；超时和输出上限只是运行控制，不是安全边界。
 * 不要将模型输出、第三方插件脚本或其他不可信代码传入。它不提供 QuickJS/WASM worker、
 * 独立进程或容器级隔离；模型代码应使用显式 opt-in 的 Codemode 执行路径。
 */

import * as vm from 'node:vm';
import { InvalidDiceNotationError } from '../errors.js';
import type { Clock } from '../ports/index.js';
import { REAL_CLOCK } from '../ports/index.js';

/** 沙箱执行的统一默认超时（毫秒）。原先 3000 / 2000 / 1000 三处魔法值统一收敛到这里。 */
export const DEFAULT_SANDBOX_TIMEOUT_MS = 3000;

export interface SandboxExecutionOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  globals?: Record<string, unknown>;
}

export interface SandboxExecutionResult<T = any> {
  success: boolean;
  result?: T;
  stdout: string[];
  stderr: string[];
  executionTimeMs: number;
  error?: string;
  terminatedByTimeout?: boolean;
}

/** Host execution adapter; this interface does not itself guarantee code isolation. */
export interface SandboxRunner {
  execute<T = any>(code: string, options?: SandboxExecutionOptions): Promise<SandboxExecutionResult<T>>;
}

/**
 * 基于 `node:vm` 的可信计算辅助工具。
 * `vm` 不构成安全边界；仅可执行宿主控制的可信脚本。
 */
export class NodeVMSandbox implements SandboxRunner {
  private defaultTimeoutMs: number;
  private maxOutputChars: number;
  private clock: Clock;

  constructor(options: { defaultTimeoutMs?: number; maxOutputChars?: number; clock?: Clock } = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs || DEFAULT_SANDBOX_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars || 65536;
    this.clock = options.clock || REAL_CLOCK;
  }

  public async execute<T = any>(
    code: string,
    options: SandboxExecutionOptions = {}
  ): Promise<SandboxExecutionResult<T>> {
    const startTime = this.clock();
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;
    const maxChars = options.maxOutputChars || this.maxOutputChars;

    const stdout: string[] = [];
    const stderr: string[] = [];

    // 提供受限输出的 console 适配器；字符上限是容量控制，不是隔离机制。
    const sandboxConsole = {
      log: (...args: any[]) => {
        const line = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        if (stdout.join('\n').length < maxChars) stdout.push(line);
      },
      warn: (...args: any[]) => {
        const line = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        if (stderr.join('\n').length < maxChars) stderr.push(line);
      },
      error: (...args: any[]) => {
        const line = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
        if (stderr.join('\n').length < maxChars) stderr.push(line);
      }
    };

    // 宿主提供的计算辅助函数；名称不代表沙箱安全能力。
    const calculationHelpers = {
      roll: (diceNotation: string): number => {
        // e.g. "1d20", "3d6+2"
        const match = diceNotation.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
        if (!match) {
          throw new InvalidDiceNotationError(diceNotation);
        }
        const count = Number.parseInt(match[1], 10);
        const sides = Number.parseInt(match[2], 10);
        const mod = match[3] ? Number.parseInt(match[3], 10) : 0;
        let sum = 0;
        for (let i = 0; i < count; i++) {
          sum += Math.floor(Math.random() * sides) + 1;
        }
        return sum + mod;
      }
    };

    // 仅注入常用全局量以便利可信计算；限制可见名称不构成安全隔离。
    const contextObject: Record<string, unknown> = {
      console: sandboxConsole,
      Math,
      JSON,
      Date,
      Array,
      Object,
      String,
      Number,
      Boolean,
      RegExp,
      Map,
      Set,
      ...calculationHelpers,
      ...(options.globals || {})
    };

    // 设置脚本常用别名；不防止原型链逃逸。
    contextObject.global = contextObject;
    contextObject.globalThis = contextObject;

    const vmContext = vm.createContext(contextObject);

    try {
      // 仅为常见误用提供关键词护栏，无法鉴别或阻止恶意代码。
      if (/\b(process|require|child_process|fs|net|http|cluster)\b/.test(code)) {
        throw new Error('Sandbox keyword guardrail rejected a known system-module identifier.');
      }

      const script = new vm.Script(`(() => { ${code} })()`);
      const result = script.runInContext(vmContext, {
        timeout: timeoutMs,
        displayErrors: true
      });

      return {
        success: true,
        result,
        stdout,
        stderr,
        executionTimeMs: this.clock() - startTime
      };
    } catch (err: any) {
      const isTimeout = err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || err.message?.includes('timed out');
      return {
        success: false,
        stdout,
        stderr,
        executionTimeMs: this.clock() - startTime,
        error: isTimeout ? `Script execution timed out after ${timeoutMs}ms` : err.message,
        terminatedByTimeout: isTimeout
      };
    }
  }
}

/**
 * 宿主侧可信规则/表达式计算门面。
 * 默认 NodeVMSandbox 基于 node:vm，并非安全边界；不要传入模型或插件提供的代码。
 */
export class SandboxExecutor {
  private runner: SandboxRunner;

  constructor(runner: SandboxRunner = new NodeVMSandbox()) {
    this.runner = runner;
  }

  /**
   * 执行宿主信任的规则脚本；不得传入模型输出、第三方插件代码或其他不可信字符串。
   */
  public async runRuleScript<T = any>(
    scriptCode: string,
    contextGlobals: Record<string, any> = {},
    timeoutMs: number = DEFAULT_SANDBOX_TIMEOUT_MS
  ): Promise<SandboxExecutionResult<T>> {
    return await this.runner.execute<T>(scriptCode, {
      timeoutMs,
      globals: contextGlobals
    });
  }

  /**
   * 评估宿主控制的可信表达式；该方法不提供隔离。
   */
  public async evaluateExpression<T = any>(
    expression: string,
    contextGlobals: Record<string, any> = {}
  ): Promise<SandboxExecutionResult<T>> {
    return await this.runner.execute<T>(`return (${expression});`, {
      timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
      globals: contextGlobals
    });
  }
}
