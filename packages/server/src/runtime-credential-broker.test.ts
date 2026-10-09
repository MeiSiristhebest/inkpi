import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createRuntimeCredentialResolverFromEnvironment } from './runtime-credential-broker.js';

describe('Runtime credential broker client', () => {
  it('requests a credential by reference and returns only the broker value', async () => {
    const server = createServer((socket) => {
      let request = '';
      socket.on('data', (chunk) => {
        request += chunk.toString('utf8');
        if (!request.includes('\n')) return;
        expect(JSON.parse(request)).toEqual({
          token: 'a'.repeat(32),
          credential_ref: 'inkpi.model.openai.gpt-4o'
        });
        socket.end('{"credential":"broker-secret","error":null}\n');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Test broker did not bind a TCP port');
    const resolver = createRuntimeCredentialResolverFromEnvironment({
      INKPI_CREDENTIAL_BROKER_ADDRESS: `127.0.0.1:${address.port}`,
      INKPI_CREDENTIAL_BROKER_TOKEN: 'a'.repeat(32)
    });

    try {
      await expect(resolver?.('inkpi.model.openai.gpt-4o')).resolves.toBe('broker-secret');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
  });

  it('rejects incomplete, non-loopback, and invalid credential configuration', () => {
    expect(() => createRuntimeCredentialResolverFromEnvironment({})).not.toThrow();
    expect(() =>
      createRuntimeCredentialResolverFromEnvironment({
        INKPI_CREDENTIAL_BROKER_ADDRESS: '127.0.0.1:9000'
      })
    ).toThrow('incomplete');
    expect(() =>
      createRuntimeCredentialResolverFromEnvironment({
        INKPI_CREDENTIAL_BROKER_ADDRESS: '0.0.0.0:9000',
        INKPI_CREDENTIAL_BROKER_TOKEN: 'a'.repeat(32)
      })
    ).toThrow('loopback');
  });

  it('rejects references outside the model namespace before opening a socket', async () => {
    const resolver = createRuntimeCredentialResolverFromEnvironment({
      INKPI_CREDENTIAL_BROKER_ADDRESS: '127.0.0.1:9000',
      INKPI_CREDENTIAL_BROKER_TOKEN: 'a'.repeat(32)
    });
    await expect(resolver?.('inkpi.other.secret')).rejects.toThrow('Invalid model credential reference');
  });
});
