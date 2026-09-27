import { describe, expect, it } from 'vitest';
import {
  RUNTIME_CAPABILITIES,
  RUNTIME_CONTRACT_VERSION,
  RUNTIME_PROTOCOL_VERSION,
  RUNTIME_SCHEMA_HASH
} from '../packages/protocol/src/runtime-contract.js';
import * as protocolSchemas from '../packages/protocol/src/schemas.js';
import { PROTOCOL_SCHEMA_DEFINITIONS, PROTOCOL_VERSION } from '../packages/protocol/src/schemas.js';

function contractFingerprint(schemaDefinitions: unknown): string {
  const value = [
    `protocol:${RUNTIME_PROTOCOL_VERSION}`,
    `contract:${RUNTIME_CONTRACT_VERSION}`,
    `protocol-schema:${PROTOCOL_VERSION}`,
    `schemas:${JSON.stringify(schemaDefinitions)}`,
    ...RUNTIME_CAPABILITIES
  ].join('\n');
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

describe('Runtime compatibility fingerprint', () => {
  it('registers every exported protocol schema in the fingerprint input', () => {
    const exportedSchemas = Object.keys(protocolSchemas)
      .filter((name) => name.endsWith('Schema'))
      .sort();

    expect(Object.keys(PROTOCOL_SCHEMA_DEFINITIONS).sort()).toEqual(exportedSchemas);
  });

  it('changes when a protocol schema definition changes', () => {
    const changedSchemas = {
      ...PROTOCOL_SCHEMA_DEFINITIONS,
      AssistantMessageSchema: {
        ...PROTOCOL_SCHEMA_DEFINITIONS.AssistantMessageSchema,
        description: 'test-only schema change'
      }
    };

    expect(RUNTIME_SCHEMA_HASH).toBe(contractFingerprint(PROTOCOL_SCHEMA_DEFINITIONS));
    expect(contractFingerprint(changedSchemas)).not.toBe(RUNTIME_SCHEMA_HASH);
  });
});
