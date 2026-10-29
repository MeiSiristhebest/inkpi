import { createConnection } from 'node:net';

export type RuntimeCredentialResolver = (credentialRef: string) => Promise<string | undefined>;

export interface RuntimeCredentialStore {
  get: RuntimeCredentialResolver;
  set(credentialRef: string, value: string): Promise<void>;
  remove(credentialRef: string): Promise<void>;
}

const MAX_CREDENTIAL_BYTES = 32 * 1024;
const MAX_REQUEST_BYTES = 33_792;
const MAX_RESPONSE_BYTES = 33_792;
const REQUEST_TIMEOUT_MS = 2_000;

/** Build CRUD access for the loopback broker started by the Desktop host. */
export function createRuntimeCredentialStoreFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): RuntimeCredentialStore | undefined {
  const address = environment.INKPI_CREDENTIAL_BROKER_ADDRESS;
  const token = environment.INKPI_CREDENTIAL_BROKER_TOKEN;
  if (!address && !token) return undefined;
  if (!address || !token) throw new Error('Credential broker configuration is incomplete');

  const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(address);
  const port = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Credential broker address must use an IPv4 loopback port');
  }
  if (!/^[a-f0-9]{32}$/i.test(token)) throw new Error('Credential broker token is invalid');

  return {
    get: (credentialRef) => requestCredentialBroker({ port, token, operation: 'get', credentialRef }),
    set: async (credentialRef, value) => {
      if (Buffer.byteLength(value, 'utf8') > MAX_CREDENTIAL_BYTES) {
        throw new Error('Credential value exceeds the size limit');
      }
      await requestCredentialBroker({ port, token, operation: 'set', credentialRef, value });
    },
    remove: async (credentialRef) => {
      await requestCredentialBroker({ port, token, operation: 'remove', credentialRef });
    }
  };
}

/** Backward-compatible read-only adapter for existing model routes. */
export function createRuntimeCredentialResolverFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): RuntimeCredentialResolver | undefined {
  return createRuntimeCredentialStoreFromEnvironment(environment)?.get;
}

async function requestCredentialBroker(input: {
  port: number;
  token: string;
  operation: 'get' | 'set' | 'remove';
  credentialRef: string;
  value?: string;
}): Promise<string | undefined> {
  validateCredentialRef(input.credentialRef);
  if (input.operation !== 'get' && !isChatGPTPlanCredentialRef(input.credentialRef)) {
    throw new Error('Credential writes are limited to ChatGPT plan references');
  }
  if (input.value !== undefined && Buffer.byteLength(input.value, 'utf8') > MAX_CREDENTIAL_BYTES) {
    throw new Error('Credential value exceeds the size limit');
  }

  const request = JSON.stringify({
    token: input.token,
    operation: input.operation,
    credential_ref: input.credentialRef,
    ...(input.value !== undefined ? { value: input.value } : {})
  });
  if (Buffer.byteLength(request, 'utf8') > MAX_REQUEST_BYTES) {
    throw new Error('Credential broker request exceeded the size limit');
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port: input.port });
    let settled = false;
    let response = Buffer.alloc(0);
    const finish = (error?: Error, credential?: string) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(credential);
    };

    socket.setTimeout(REQUEST_TIMEOUT_MS, () => finish(new Error('Credential broker request timed out')));
    socket.once('connect', () => {
      socket.write(`${request}\n`, (error) => {
        if (error) finish(new Error('Credential broker request failed'));
      });
    });
    socket.on('data', (chunk: Buffer) => {
      response = Buffer.concat([response, chunk]);
      if (response.length > MAX_RESPONSE_BYTES) {
        finish(new Error('Credential broker response exceeded the size limit'));
        return;
      }
      const newline = response.indexOf(10);
      if (newline < 0) return;
      try {
        const payload: unknown = JSON.parse(response.subarray(0, newline).toString('utf8'));
        if (!isRecord(payload) || payload.success !== true) throw new Error('invalid response');
        if (input.operation === 'get') {
          if (payload.credential === null) {
            finish();
            return;
          }
          if (typeof payload.credential !== 'string') throw new Error('invalid response');
          finish(undefined, payload.credential || undefined);
          return;
        }
        if (payload.credential !== null) throw new Error('invalid response');
        finish();
      } catch {
        finish(new Error('Credential broker rejected the request'));
      }
    });
    socket.once('error', () => finish(new Error('Credential broker is unavailable')));
    socket.once('end', () => {
      if (!settled) finish(new Error('Credential broker closed the request without a response'));
    });
  });
}

function validateCredentialRef(credentialRef: string): void {
  if (
    !credentialRef.startsWith('inkpi.model.') ||
    credentialRef.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(credentialRef)
  ) {
    throw new Error('Invalid model credential reference');
  }
}

function isChatGPTPlanCredentialRef(credentialRef: string): boolean {
  return (
    credentialRef === 'inkpi.model.openai-chatgpt-plan.accounts' ||
    credentialRef === 'inkpi.model.openai-chatgpt-plan.host' ||
    credentialRef === 'inkpi.model.openai-chatgpt-plan.account' ||
    /^inkpi\.model\.openai-chatgpt-plan\.account\.[a-f0-9]{32}$/i.test(credentialRef)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
