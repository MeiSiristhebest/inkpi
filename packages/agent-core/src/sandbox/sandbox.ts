/**
 * 微虚拟机 / 容器安全沙箱隔离引擎
 * 用于安全隔离执行第三方规则引擎脚本、自定义表达式求值与计算仿真逻辑，
 * 具备 CPU 超时熔断（Timeout Protection）、内存隔离、越权系统调用（fs/net/process）拦截与输出流截断。
 */

import * as vm from 'node:vm';
import { InvalidDiceNotationError } from '../errors.js';

/** 沙箱执行的统一默认超时（毫秒）。原先 3000 / 2000 / 1000 三处魔法值统一收敛到这里。 */
export const DEFAULT_SANDBOX_TIMEOUT_MS = 3000;

export interface SandboxExecutionOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  globals?: Record<string, any>;
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

export interface SandboxRunner {
  execute<T = any>(code: string, options?: SandboxExecutionOptions): Promise<SandboxExecutionResult<T>>;
}

/**
 * 基于 Node.js 受限安全上下文的内存隔离沙箱 (NodeVMSandbox)
 */
export class NodeVMSandbox implements SandboxRunner {
  private defaultTimeoutMs: number;
  private maxOutputChars: number;

  constructor(options: { defaultTimeoutMs?: number; maxOutputChars?: number } = {}) {
    this.defaultTimeoutMs = options.defaultTimeoutMs || DEFAULT_SANDBOX_TIMEOUT_MS;
    this.maxOutputChars = options.maxOutputChars || 65536;
  }

  public async execute<T = any>(code: string, options: SandboxExecutionOptions = {}): Promise<SandboxExecutionResult<T>> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs || this.defaultTimeoutMs;
    const maxChars = options.maxOutputChars || this.maxOutputChars;

    const stdout: string[] = [];
    const stderr: string[] = [];

    // 创建安全隔离的沙箱控制台
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

    // 内置常用安全辅助函数（如随机数与数值计算）
    const sandboxSafeGlobals = {
      roll: (diceNotation: string): number => {
        // e.g. "1d20", "3d6+2"
        const match = diceNotation.match(/^(\d+)d(\d+)([+-]\d+)?$/i);
        if (!match) {
          throw new InvalidDiceNotationError(diceNotation);
        }
        const count = parseInt(match[1], 10);
        const sides = parseInt(match[2], 10);
        const mod = match[3] ? parseInt(match[3], 10) : 0;
        let sum = 0;
        for (let i = 0; i < count; i++) {
          sum += Math.floor(Math.random() * sides) + 1;
        }
        return sum + mod;
      }
    };

    // 严密隔离的 Sandbox 上下文，彻底移除 process, require, import, fs, child_process
    const contextObject: Record<string, any> = {
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
      ...sandboxSafeGlobals,
      ...(options.globals || {})
    };

    // 防止原型链逃逸
    contextObject.global = contextObject;
    contextObject.globalThis = contextObject;

    const vmContext = vm.createContext(contextObject);

    try {
      // 静态防护：禁止代码内直接引用 process / require / child_process
      if (/\b(process|require|child_process|fs|net|http|cluster)\b/.test(code)) {
        throw new Error('Sandbox Security Violation: Access to system modules (process/fs/net) is strictly forbidden.');
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
        executionTimeMs: Date.now() - startTime
      };
    } catch (err: any) {
      const isTimeout = err.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' || err.message?.includes('timed out');
      return {
        success: false,
        stdout,
        stderr,
        executionTimeMs: Date.now() - startTime,
        error: isTimeout ? `Script execution timed out after ${timeoutMs}ms` : err.message,
        terminatedByTimeout: isTimeout
      };
    }
  }
}

/**
 * 统一沙箱执行门面 (SandboxExecutor)
 * 包装任意 SandboxRunner，对外提供规则脚本与表达式两类安全求值入口。
 */
export class SandboxExecutor {
  private runner: SandboxRunner;

  constructor(runner: SandboxRunner = new NodeVMSandbox()) {
    this.runner = runner;
  }

  /**
   * 执行一段自定义规则引擎脚本（如数值计算、规则求值与逻辑检定）
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
   * 安全评估表达式
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
