import { createConnection } from 'node:net';

export type RuntimeCredentialResolver = (credentialRef: string) => Promise<string | undefined>;

const MAX_RESPONSE_BYTES = 8_192;
const REQUEST_TIMEOUT_MS = 2_000;

/** Build a resolver for the loopback broker started by the Desktop host. */
export function createRuntimeCredentialResolverFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): RuntimeCredentialResolver | undefined {
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

  return (credentialRef) => resolveCredential({ port, token, credentialRef });
}

function resolveCredential(input: {
  port: number;
  token: string;
  credentialRef: string;
}): Promise<string | undefined> {
  if (
    !input.credentialRef.startsWith('inkpi.model.') ||
    input.credentialRef.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(input.credentialRef)
  ) {
    return Promise.reject(new Error('Invalid model credential reference'));
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
      socket.write(`${JSON.stringify({ token: input.token, credential_ref: input.credentialRef })}\n`, (error) => {
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
        if (!isRecord(payload)) throw new Error('invalid response');
        if (typeof payload.error === 'string') throw new Error(payload.error);
        if (payload.credential === null) {
          finish();
          return;
        }
        if (typeof payload.credential !== 'string') throw new Error('invalid response');
        finish(undefined, payload.credential || undefined);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
