import {
  DESKTOP_REQUIRED_RUNTIME_CAPABILITIES,
  RUNTIME_SCHEMA_HASH,
  createRuntimeHandshakeRequest
} from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { InkPiDaemon } from './daemon.js';

describe('Runtime compatibility contract', () => {
  it('accepts the current Desktop contract and advertises only available optional capabilities', async () => {
    const daemon = new InkPiDaemon();
    const request = createRuntimeHandshakeRequest({
      clientName: 'inkpi-desktop-test',
      requiredCapabilities: DESKTOP_REQUIRED_RUNTIME_CAPABILITIES
    });

    const response = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 'handshake-1',
      method: 'runtime.handshake',
      params: request
    });

    if (response.error) throw new Error(response.error.message);
    expect(response.result).toMatchObject({
      accepted: true,
      protocolVersion: request.protocolVersion,
      contractVersion: request.contractVersion,
      schemaHash: RUNTIME_SCHEMA_HASH,
      runtimeVersion: '2.0.0',
      missingCapabilities: []
    });
    expect((response.result as { capabilities: string[] }).capabilities).not.toContain('artifact.list');
  });

  it('rejects an incompatible schema without dispatching a product capability', async () => {
    const daemon = new InkPiDaemon();
    const request = createRuntimeHandshakeRequest({
      clientName: 'old-desktop',
      requiredCapabilities: DESKTOP_REQUIRED_RUNTIME_CAPABILITIES
    });

    const response = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 'handshake-2',
      method: 'runtime.handshake',
      params: { ...request, schemaHash: '00000000' }
    });

    if (response.error) throw new Error(response.error.message);
    expect(response.result).toMatchObject({
      accepted: false,
      schemaHash: RUNTIME_SCHEMA_HASH,
      missingCapabilities: [],
      reason: expect.stringContaining('mismatch')
    });
  });

  it('rejects clients that use the previous contract version', async () => {
    const daemon = new InkPiDaemon();
    const request = createRuntimeHandshakeRequest({
      clientName: 'inkpi-desktop-v1',
      requiredCapabilities: DESKTOP_REQUIRED_RUNTIME_CAPABILITIES
    });

    const response = await daemon.getRpcServer().handleRequest({
      jsonrpc: '2.0',
      id: 'handshake-v1',
      method: 'runtime.handshake',
      params: { ...request, contractVersion: 1 }
    });

    if (response.error) throw new Error(response.error.message);
    expect(response.result).toMatchObject({
      accepted: false,
      contractVersion: 2,
      schemaHash: RUNTIME_SCHEMA_HASH,
      missingCapabilities: [],
      reason: expect.stringContaining('mismatch')
    });
  });
});
