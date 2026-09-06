/**
 * Domain ports — the inner abstraction owned by `@inkpi/agent-core`.
 *
 * Per the hexagonal (ports & adapters) discipline, the *abstraction* is declared
 * by the domain core, and concrete adapters (which live in `@inkpi/ai`,
 * `@inkpi/storage`, the CLI, the server, …) implement it. This file must not
 * import runtime code from those outer packages — only protocol types and
 * type-only references. Adapters are wired at the composition root, never as
 * default fallbacks inside the core.
 */

import type { EventStream, StreamOptions } from '@inkpi/ai';
import type { AgentMessage, AssistantMessageEvent, ModelConfig } from '@inkpi/protocol';
import type { ManagedSession, SessionCreateOptions, SessionSummary } from '../rpc/session-registry.js';

export { nodeFileSystem } from '../adapters/node-filesystem.js';

/** Wall-clock / monotonic time source. Inject a test clock; never call `Date.now()` directly. */
export type Clock = () => number;

/**
 * The real system clock. Provided **once** at the composition root
 * (`daemon.ts`, `print-mode.ts`, …) and injected downward.
 * Port-implementing sites must take `Clock` as a required parameter — never
 * fall back to `Date.now` themselves, or the injection becomes a no-op.
 */
export const REAL_CLOCK: Clock = Date.now;

/** Stable identifier generator. Inject a deterministic generator in tests. */
export type IdGenerator = () => string;

/** Structured logging port. Replace `console.*` calls with an injected `Logger`. */
export interface Logger {
  debug(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

/** Default logger backed by the global console. */
export const consoleLogger: Logger = {
  debug: (m, ...a) => console.debug(m, ...a),
  info: (m, ...a) => console.info(m, ...a),
  warn: (m, ...a) => console.warn(m, ...a),
  error: (m, ...a) => console.error(m, ...a)
};

/** Filesystem port. Keeps OS-infrastructure code (package-manager, trust, clipboard) testable. */
export interface FileSystem {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options?: { recursive?: boolean }): void;
  readFileSync(path: string, encoding?: BufferEncoding): string | Buffer;
  readdirSync(path: string): string[];
  renameSync(oldPath: string, newPath: string): void;
  rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  writeFileSync(path: string, data: string | Uint8Array): void;
}

/**
 * Model streaming port. Mirrors the `@inkpi/ai` `StreamFn` contract but is
 * declared by the core, so the loop depends on the abstraction, not the
 * concrete provider. A `ModelStreamer` implementation is supplied by the
 * composition root (never a default fallback inside the core).
 */
export type ModelStreamer = (
  model: ModelConfig,
  messages: AgentMessage[],
  options?: StreamOptions
) => EventStream<AssistantMessageEvent>;

/**
 * 思考预算与档位解析端口 (ThinkingMapper Port)
 * 供 agent-core 在执行轮次时根据 thinkingLevel 解析对应的 effort 档位或 token 预算，
 * 避免 agent-core 直接依赖具体 @inkpi/ai 的运行时映射函数 (DIP)。
 */
export interface ThinkingMapper {
  mapThinkingLevelToEffort(level: string | null | undefined): any;
  getThinkingBudgetForLevel(level: string | null | undefined): number | undefined;
}

/**
 * Multi-session store port. The live in-memory `SessionRegistry` is one
 * adapter; a persisted or remote adapter could replace it without the domain
 * loop knowing.
 */
export interface SessionStore {
  createSession(options?: SessionCreateOptions): ManagedSession;
  getSession(sessionId: string): ManagedSession | undefined;
  getOrCreateSession(sessionId?: string, options?: SessionCreateOptions): ManagedSession;
  closeSession(sessionId: string): boolean;
  listSessions(): SessionSummary[];
  clear(): void;
}
