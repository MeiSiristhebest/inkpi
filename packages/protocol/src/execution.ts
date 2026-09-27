import type { ToolExecutionMode, ToolReplayPolicy } from './extensions.js';
import { type JsonObject, type JsonValue, assertJsonValue } from './json.js';

/** JSON-safe, secret-free description of one executable model route. */
export interface ExecutionModelSnapshot {
  canonicalId?: string;
  provider: string;
  modelId: string;
  displayName?: string;
  baseUrl?: string;
  thinkingLevel?: string;
}

/** JSON-safe tool contract captured for reproducibility; execute functions are never serialized. */
export interface ExecutionToolSnapshot {
  name: string;
  label?: string;
  description: string;
  parameters?: JsonValue;
  executionMode?: ToolExecutionMode;
  replay?: ToolReplayPolicy;
}

export interface ExecutionInstructionsSnapshot {
  systemPrompt: string;
  thinkingLevel?: string;
}

export interface ExecutionContextSnapshot {
  messageCount: number;
  messageIds: string[];
  fingerprint: string;
  estimatedTokens?: number;
}

/**
 * Reproducibility manifest for one run. It intentionally contains no API keys,
 * tool functions, arbitrary message payloads, or provider response bodies.
 */
export interface ExecutionSnapshot {
  version: 1;
  id: string;
  taskId?: string;
  createdAt: number;
  model: ExecutionModelSnapshot;
  instructions: ExecutionInstructionsSnapshot;
  tools: ExecutionToolSnapshot[];
  context: ExecutionContextSnapshot;
  policy?: JsonObject;
  metadata?: JsonObject;
}

/** Content-complete durable intent written before an external effect. */
export interface ExecutionPlan {
  version: 1;
  id: string;
  taskId?: string;
  createdAt: number;
  operation: 'tool_call' | 'provider_call' | 'workflow_stage';
  target: string;
  input: JsonValue;
  replay: ToolReplayPolicy;
  fingerprint: string;
}

/** Durable outcome written after the planned effect settles. */
export interface ExecutionSettlement {
  version: 1;
  id: string;
  planId: string;
  settledAt: number;
  status: 'settled' | 'failed' | 'aborted';
  planFingerprint: string;
  result?: JsonValue;
  error?: string;
  fingerprint: string;
}

export function createExecutionPlan(input: Omit<ExecutionPlan, 'version' | 'fingerprint'>): ExecutionPlan {
  const plan = { version: 1 as const, ...input };
  assertJsonValue(plan.input, 'Execution plan input');
  return { ...plan, fingerprint: sha256Hex(stableJson(plan)) };
}

export function createExecutionSettlement(
  input: Omit<ExecutionSettlement, 'version' | 'fingerprint'>
): ExecutionSettlement {
  const settlement = { version: 1 as const, ...input };
  if (settlement.result !== undefined) assertJsonValue(settlement.result, 'Execution settlement result');
  return { ...settlement, fingerprint: sha256Hex(stableJson(settlement)) };
}

/** Deterministic JSON used for durable fingerprints (object keys are sorted). */
export function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Cannot fingerprint a non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  throw new Error('Cannot fingerprint a non-JSON value');
}

/** Small dependency-free SHA-256 implementation for shared Runtime/browser code. */
export function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const words = new Uint32Array(64);
  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
  ]);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98,
    0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8,
    0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819,
    0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
    0xc67178f2
  ];
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const x = words[i - 15];
      const y = words[i - 2];
      words[i] = (smallSigma1(y) + words[i - 7] + smallSigma0(x) + words[i - 16]) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + bigSigma1(e) + ((e & f) ^ (~e & g)) + constants[i] + words[i]) >>> 0;
      const t2 = (bigSigma0(a) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [h, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }
  return [...hash].map((word) => word.toString(16).padStart(8, '0')).join('');
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}
function smallSigma0(value: number): number {
  return rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3);
}
function smallSigma1(value: number): number {
  return rotateRight(value, 17) ^ rotateRight(value, 19) ^ (value >>> 10);
}
function bigSigma0(value: number): number {
  return rotateRight(value, 2) ^ rotateRight(value, 13) ^ rotateRight(value, 22);
}
function bigSigma1(value: number): number {
  return rotateRight(value, 6) ^ rotateRight(value, 11) ^ rotateRight(value, 25);
}
