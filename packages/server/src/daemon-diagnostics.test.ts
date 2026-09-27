import { DiagnosticSnapshotSchema, validateSchema } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { InkPiDaemon } from './daemon.js';

describe('Runtime diagnostics boundary', () => {
  it('returns a read-only secret-free snapshot with contract and cache state', async () => {
    const daemon = new InkPiDaemon({
      modelRoutes: [
        {
          id: 'diagnostic-route',
          model: { id: 'diagnostic-model', name: 'Diagnostic model', provider: 'openai', apiKey: 'request-only-secret' }
        }
      ]
    });

    try {
      const response = await daemon.getRpcServer().handleRequest({
        jsonrpc: '2.0',
        id: 'diagnostics',
        method: 'runtime.diagnostics'
      });
      expect(response.error).toBeUndefined();
      const validation = validateSchema(DiagnosticSnapshotSchema, response.result);
      expect(validation.errors).toEqual([]);
      expect(response.result).toMatchObject({
        version: 1,
        runtime: {
          protocolVersion: 'inkpi.runtime.v1',
          contractVersion: 1,
          capabilities: expect.arrayContaining(['runtime.diagnostics'])
        },
        modelRoutes: { configured: 1 },
        cache: { version: 1 }
      });
      expect(JSON.stringify(response.result)).not.toContain('request-only-secret');
      expect(JSON.stringify(response.result)).not.toContain('diagnostic-model');
    } finally {
      await daemon.stop();
    }
  });
});
