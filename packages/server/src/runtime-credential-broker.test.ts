import { createServer } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  createRuntimeCredentialResolverFromEnvironment,
  createRuntimeCredentialStoreFromEnvironment
} from './runtime-credential-broker.js';

const BROKER_TOKEN = 'a'.repeat(32);

async function listen(server: ReturnType<typeof createServer>): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test broker did not bind a TCP port');
  return address.port;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe('Runtime credential broker client', () => {
  it('requests a credential by reference and returns only the broker value', async () => {
    const server = createServer((socket) => {
      let request = '';
      socket.on('data', (chunk) => {
        request += chunk.toString('utf8');
        if (!request.includes('\n')) return;
        expect(JSON.parse(request)).toEqual({
          token: BROKER_TOKEN,
          operation: 'get',
          credential_ref: 'inkpi.model.openai.gpt-4o'
        });
        socket.end('{"credential":"broker-secret","success":true,"error":null}\n');
      });
    });

    const port = await listen(server);
    const resolver = createRuntimeCredentialResolverFromEnvironment({
      INKPI_CREDENTIAL_BROKER_ADDRESS: `127.0.0.1:${port}`,
      INKPI_CREDENTIAL_BROKER_TOKEN: BROKER_TOKEN
    });

    try {
      await expect(resolver?.('inkpi.model.openai.gpt-4o')).resolves.toBe('broker-secret');
    } finally {
      await close(server);
    }
  });

  it('writes and removes only ChatGPT account references through the broker', async () => {
    const received: unknown[] = [];
    const server = createServer((socket) => {
      let request = '';
      socket.on('data', (chunk) => {
        request += chunk.toString('utf8');
        if (!request.includes('\n')) return;
        received.push(JSON.parse(request));
        socket.end('{"credential":null,"success":true,"error":null}\n');
      });
    });
    const port = await listen(server);
    const store = createRuntimeCredentialStoreFromEnvironment({
      INKPI_CREDENTIAL_BROKER_ADDRESS: `127.0.0.1:${port}`,
      INKPI_CREDENTIAL_BROKER_TOKEN: BROKER_TOKEN
    });
    const accountRef = `inkpi.model.openai-chatgpt-plan.account.${'b'.repeat(32)}`;

    try {
      await store?.set(accountRef, '{"refreshToken":"secret"}');
      await store?.remove('inkpi.model.openai-chatgpt-plan.accounts');
      expect(received).toEqual([
        {
          token: BROKER_TOKEN,
          operation: 'set',
          credential_ref: accountRef,
          value: '{"refreshToken":"secret"}'
        },
        {
          token: BROKER_TOKEN,
          operation: 'remove',
          credential_ref: 'inkpi.model.openai-chatgpt-plan.accounts'
        }
      ]);
      await expect(store?.set('inkpi.model.openai.gpt-4o', 'secret')).rejects.toThrow(
        'limited to ChatGPT plan references'
      );
    } finally {
      await close(server);
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
        INKPI_CREDENTIAL_BROKER_TOKEN: BROKER_TOKEN
      })
    ).toThrow('loopback');
  });

  it('rejects references outside the model namespace before opening a socket', async () => {
    const resolver = createRuntimeCredentialResolverFromEnvironment({
      INKPI_CREDENTIAL_BROKER_ADDRESS: '127.0.0.1:9000',
      INKPI_CREDENTIAL_BROKER_TOKEN: BROKER_TOKEN
    });
    await expect(resolver?.('inkpi.other.secret')).rejects.toThrow('Invalid model credential reference');
  });
});
