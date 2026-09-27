/**
 * Versioned Desktop <-> Runtime compatibility contract.
 *
 * The schema fingerprint is deliberately deterministic and dependency-free so
 * it can be checked in a browser WebView before any product RPC is used. It
 * is a compatibility fingerprint, not an authentication mechanism.
 */

import { PROTOCOL_SCHEMA_DEFINITIONS, PROTOCOL_VERSION } from './schemas.js';

export const RUNTIME_PROTOCOL_VERSION = 'inkpi.runtime.v1' as const;
export const RUNTIME_CONTRACT_VERSION = 1 as const;

/** Loopback-only endpoint defaults shared by CLI, Runtime, and Desktop. */
export const DEFAULT_RPC_HOST = '127.0.0.1';
export const DEFAULT_RPC_PORT = 8848;
export const DEFAULT_RPC_WS_PORT = 8849;
export const RUNTIME_IMPLEMENTATION_VERSION = '1.0.0' as const;

/** RPC capabilities that may be advertised by an InkPi Runtime. */
export const RUNTIME_CAPABILITIES = [
  'runtime.handshake',
  'runtime.diagnostics',
  'daemon.status',
  'instruction.register',
  'instruction.status',
  'skill.discover',
  'skill.resolve',
  'skill.load',
  'skill.activate',
  'skill.status',
  'task.submit',
  'task.status',
  'task.execution',
  'task.cancel',
  'task.steer',
  'task.resume',
  'task.replay',
  'task.fork',
  'cache.status',
  'cache.invalidate',
  'domain.sync.push',
  'domain.sync.pull',
  'domain.sync.snapshot',
  'domain.sync.restore',
  'proposal.sync.push',
  'proposal.sync.snapshot',
  'artifact.save',
  'artifact.get',
  'artifact.list',
  'workspace.purge',
  'tool.list',
  'tool.execute',
  'model.routes.list',
  'model.routes.configure',
  'model.routes.remove',
  'model.routes.health'
] as const;

export type RuntimeCapability = (typeof RUNTIME_CAPABILITIES)[number];

/** Capabilities required before Desktop treats a Runtime connection as usable. */
export const DESKTOP_REQUIRED_RUNTIME_CAPABILITIES = [
  'runtime.handshake',
  'daemon.status',
  'instruction.register',
  'skill.activate',
  'task.submit',
  'task.status',
  'task.execution',
  'task.cancel',
  'task.steer',
  'task.resume',
  'cache.status',
  'cache.invalidate',
  'model.routes.list',
  'model.routes.configure',
  'model.routes.remove',
  'model.routes.health'
] as const satisfies readonly RuntimeCapability[];

export interface RuntimeHandshakeRequest {
  protocolVersion: string;
  contractVersion: number;
  schemaHash: string;
  clientName: string;
  clientVersion?: string;
  requiredCapabilities: readonly string[];
}

export interface RuntimeHandshakeResponse {
  accepted: boolean;
  protocolVersion: string;
  contractVersion: number;
  schemaHash: string;
  runtimeVersion: string;
  capabilities: string[];
  missingCapabilities: string[];
  reason?: string;
}

/**
 * Stable FNV-1a fingerprint of the wire contract. This is intentionally
 * synchronous and portable; a cryptographic digest must not be inferred from
 * this value.
 */
export const RUNTIME_SCHEMA_HASH = stableFingerprint(
  [
    `protocol:${RUNTIME_PROTOCOL_VERSION}`,
    `contract:${RUNTIME_CONTRACT_VERSION}`,
    `protocol-schema:${PROTOCOL_VERSION}`,
    `schemas:${JSON.stringify(PROTOCOL_SCHEMA_DEFINITIONS)}`,
    ...RUNTIME_CAPABILITIES
  ].join('\n')
);

export function assertRuntimeHandshakeRequest(value: unknown): asserts value is RuntimeHandshakeRequest {
  if (!isRecord(value)) throw new Error('Runtime handshake request is not an object');
  if (typeof value.protocolVersion !== 'string' || !value.protocolVersion.trim()) {
    throw new Error('Runtime handshake protocolVersion is required');
  }
  if (
    typeof value.contractVersion !== 'number' ||
    !Number.isSafeInteger(value.contractVersion) ||
    value.contractVersion < 1
  ) {
    throw new Error('Runtime handshake contractVersion is invalid');
  }
  if (typeof value.schemaHash !== 'string' || !value.schemaHash.trim()) {
    throw new Error('Runtime handshake schemaHash is required');
  }
  if (typeof value.clientName !== 'string' || !value.clientName.trim()) {
    throw new Error('Runtime handshake clientName is required');
  }
  if (value.clientVersion !== undefined && (typeof value.clientVersion !== 'string' || !value.clientVersion.trim())) {
    throw new Error('Runtime handshake clientVersion is invalid');
  }
  if (!Array.isArray(value.requiredCapabilities) || !value.requiredCapabilities.every(isNonEmptyString)) {
    throw new Error('Runtime handshake requiredCapabilities are invalid');
  }
}

export function createRuntimeHandshakeRequest(options: {
  clientName: string;
  clientVersion?: string;
  requiredCapabilities?: readonly string[];
}): RuntimeHandshakeRequest {
  const clientName = options.clientName.trim();
  if (!clientName) throw new Error('Runtime handshake clientName must not be empty');
  return {
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    contractVersion: RUNTIME_CONTRACT_VERSION,
    schemaHash: RUNTIME_SCHEMA_HASH,
    clientName,
    ...(options.clientVersion?.trim() ? { clientVersion: options.clientVersion.trim() } : {}),
    requiredCapabilities: [...(options.requiredCapabilities ?? [])]
  };
}

export function isRuntimeCapability(value: unknown): value is RuntimeCapability {
  return typeof value === 'string' && (RUNTIME_CAPABILITIES as readonly string[]).includes(value);
}

export function assertRuntimeHandshakeResponse(
  value: unknown,
  requiredCapabilities: readonly string[] = DESKTOP_REQUIRED_RUNTIME_CAPABILITIES
): asserts value is RuntimeHandshakeResponse {
  if (!isRecord(value)) throw new Error('Runtime handshake response is not an object');
  if (value.accepted !== true) {
    throw new Error(`Runtime compatibility rejected${typeof value.reason === 'string' ? `: ${value.reason}` : ''}`);
  }
  if (value.protocolVersion !== RUNTIME_PROTOCOL_VERSION) {
    throw new Error(
      `Runtime protocol mismatch: expected ${RUNTIME_PROTOCOL_VERSION}, received ${String(value.protocolVersion)}`
    );
  }
  if (value.contractVersion !== RUNTIME_CONTRACT_VERSION) {
    throw new Error(
      `Runtime contract mismatch: expected ${RUNTIME_CONTRACT_VERSION}, received ${String(value.contractVersion)}`
    );
  }
  if (value.schemaHash !== RUNTIME_SCHEMA_HASH) {
    throw new Error(`Runtime schema mismatch: expected ${RUNTIME_SCHEMA_HASH}, received ${String(value.schemaHash)}`);
  }
  if (typeof value.runtimeVersion !== 'string' || !value.runtimeVersion.trim()) {
    throw new Error('Runtime handshake did not report a runtime version');
  }
  if (!Array.isArray(value.capabilities) || !value.capabilities.every(isNonEmptyString)) {
    throw new Error('Runtime handshake capabilities are invalid');
  }
  const capabilities = new Set(value.capabilities);
  const missing = requiredCapabilities.filter((capability) => !capabilities.has(capability));
  if (missing.length > 0) {
    throw new Error(`Runtime is missing required capabilities: ${missing.join(', ')}`);
  }
}

export function createRuntimeHandshakeResponse(options: {
  runtimeVersion: string;
  capabilities: readonly string[];
  request: RuntimeHandshakeRequest;
}): RuntimeHandshakeResponse {
  const capabilities = [...new Set(options.capabilities)].sort();
  const missingCapabilities = options.request.requiredCapabilities.filter(
    (capability) => !capabilities.includes(capability)
  );
  const compatible =
    options.request.protocolVersion === RUNTIME_PROTOCOL_VERSION &&
    options.request.contractVersion === RUNTIME_CONTRACT_VERSION &&
    options.request.schemaHash === RUNTIME_SCHEMA_HASH &&
    missingCapabilities.length === 0;

  return {
    accepted: compatible,
    protocolVersion: RUNTIME_PROTOCOL_VERSION,
    contractVersion: RUNTIME_CONTRACT_VERSION,
    schemaHash: RUNTIME_SCHEMA_HASH,
    runtimeVersion: options.runtimeVersion,
    capabilities,
    missingCapabilities,
    ...(compatible
      ? {}
      : {
          reason:
            missingCapabilities.length > 0
              ? `Missing capabilities: ${missingCapabilities.join(', ')}`
              : 'Protocol, contract version, or schema hash mismatch'
        })
  };
}

function stableFingerprint(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
