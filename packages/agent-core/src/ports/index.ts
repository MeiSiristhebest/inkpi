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

import type { AgentMessage, AssistantMessageEvent, ModelConfig } from '@inkpi/protocol';
import type { EventStream, StreamOptions } from '@inkpi/ai';
import type { ManagedSession, SessionCreateOptions, SessionSummary } from '../rpc/session-manager.js';
import * as nodeFs from 'node:fs';

/** Wall-clock / monotonic time source. Inject a test clock; never call `Date.now()` directly. */
export type Clock = () => number;

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

/** Default filesystem backed by `node:fs`. */
export const nodeFileSystem: FileSystem = {
  existsSync: (p) => nodeFs.existsSync(p),
  mkdirSync: (p, o) => nodeFs.mkdirSync(p, o),
  readFileSync: (p, e) => nodeFs.readFileSync(p, e),
  readdirSync: (p) => nodeFs.readdirSync(p),
  renameSync: (o, n) => nodeFs.renameSync(o, n),
  rmSync: (p, o) => nodeFs.rmSync(p, o),
  writeFileSync: (p, d) => nodeFs.writeFileSync(p, d)
};

/**
 * Model streaming port. Mirrors the `@inkpi/ai` `StreamFn` contract but is
 * declared by the core, so the loop depends on the abstraction, not the
 * concrete provider. A `ModelStreamer` implementation is supplied by the
 * composition root (never a default fallback inside the core).
 */
export interface ModelStreamer {
  (model: ModelConfig, messages: AgentMessage[], options?: StreamOptions): EventStream<AssistantMessageEvent>;
}

/**
 * Multi-session store port. The live in-memory `LiveSessionManager` is one
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
