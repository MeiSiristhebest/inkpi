import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { getHttpClient } from './http-client.js';

export interface OAuthFlowOptions {
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  /** Use 0 to bind an available loopback port. */
  port?: number;
  redirectPath?: string;
  /** PKCE is enabled unless a provider explicitly requires it to be disabled. */
  pkce?: boolean;
  signal?: AbortSignal;
  /** Persist the token result before the flow resolves. */
  onToken?: (tokens: OAuthTokenResult) => Promise<void> | void;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
}

export interface OAuthRefreshOptions {
  clientId: string;
  clientSecret?: string;
  tokenUrl: string;
  refreshToken: string;
  signal?: AbortSignal;
  /** Persist a rotated refresh token before this helper returns. */
  onToken?: (tokens: OAuthTokenResult) => Promise<void> | void;
}

/** Generate an OAuth authorization URL. The flow helper supplies a PKCE challenge. */
export function getOAuthAuthorizeUrl(
  options: OAuthFlowOptions,
  redirectUri: string,
  state: string,
  codeChallenge?: string
): string {
  let url: URL;
  try {
    url = new URL(options.authorizationUrl);
  } catch (error) {
    throw new Error(`Invalid authorizationUrl: '${options.authorizationUrl}'`, { cause: error });
  }
  if (state.trim().length === 0) throw new Error('OAuth state must not be empty.');
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', options.scopes.join(' '));
  url.searchParams.set('state', state);
  if (codeChallenge) {
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  return url.toString();
}

/** Listen on loopback, validate the callback, exchange the code, and persist returned tokens. */
export async function startOAuthLoginFlow(
  options: OAuthFlowOptions,
  onPromptUrl?: (url: string) => void
): Promise<OAuthTokenResult> {
  if (options.signal?.aborted) throw createAbortError();

  const authorizationUrl = validateEndpoint(options.authorizationUrl, 'authorizationUrl');
  const tokenUrl = validateEndpoint(options.tokenUrl, 'tokenUrl');
  const port = options.port ?? 18420;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new RangeError('OAuth callback port is invalid.');
  const redirectPath = normalizeRedirectPath(options.redirectPath ?? '/oauth/callback');
  const state = randomBytes(32).toString('base64url');
  const verifier = options.pkce === false ? undefined : randomBytes(32).toString('base64url');
  const challenge = verifier ? createHash('sha256').update(verifier).digest('base64url') : undefined;

  return new Promise<OAuthTokenResult>((resolve, reject) => {
    const server = createServer();
    let redirectUri = '';
    let settled = false;

    const closeServer = () => {
      if (server.listening) server.close();
    };
    function finish(error?: unknown, tokens?: OAuthTokenResult): void {
      if (settled) return;
      settled = true;
      closeServer();
      if (abortHandler) options.signal?.removeEventListener('abort', abortHandler);
      server.removeListener('error', onServerError);
      if (error !== undefined) reject(error);
      else resolve(tokens!);
    }
    const onServerError = (error: Error) => finish(error);

    const abortHandler = () => finish(createAbortError());
    options.signal?.addEventListener('abort', abortHandler, { once: true });
    server.on('error', onServerError);
    server.on('request', (request, response) => {
      if (settled) {
        response.writeHead(410);
        response.end();
        return;
      }
      if (request.method !== 'GET') {
        response.writeHead(405, { Allow: 'GET' });
        response.end();
        return;
      }

      let callback: URL;
      try {
        callback = new URL(request.url ?? '', redirectUri);
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (callback.pathname !== redirectPath) {
        response.writeHead(404);
        response.end();
        return;
      }

      const receivedState = callback.searchParams.get('state');
      if (receivedState !== state) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<h3>Authorization state validation failed.</h3>');
        finish(new Error('OAuth state mismatch'));
        return;
      }

      const providerError = callback.searchParams.get('error');
      if (providerError) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<h3>Authorization was not completed.</h3>');
        finish(new Error(`OAuth authorization failed: ${providerError}`));
        return;
      }

      const code = callback.searchParams.get('code');
      if (!code) {
        response.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<h3>Missing authorization code.</h3>');
        finish(new Error('Missing authorization code'));
        return;
      }

      void exchangeCode(code, tokenUrl, redirectUri, verifier, options)
        .then((tokens) => {
          if (settled) {
            response.writeHead(410);
            response.end();
            return;
          }
          response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end('<h3>Authentication successful. You can close this window.</h3>');
          finish(undefined, tokens);
        })
        .catch((error: unknown) => {
          if (settled) {
            response.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
            response.end('<h3>Authentication was cancelled.</h3>');
            return;
          }
          response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          response.end('<h3>Authentication failed.</h3>');
          finish(error);
        });
    });

    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        finish(new Error('OAuth callback server did not bind a TCP port.'));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}${redirectPath}`;
      try {
        const authUrl = getOAuthAuthorizeUrl(
          { ...options, authorizationUrl: authorizationUrl.toString() },
          redirectUri,
          state,
          challenge
        );
        onPromptUrl?.(authUrl);
      } catch (error) {
        finish(error);
      }
    });
  });
}

/** Exchange a stored refresh token and persist any rotated token before returning. */
export async function refreshOAuthToken(options: OAuthRefreshOptions): Promise<OAuthTokenResult> {
  if (options.signal?.aborted) throw createAbortError();
  const tokenUrl = validateEndpoint(options.tokenUrl, 'tokenUrl');
  const body = new URLSearchParams({
    client_id: options.clientId,
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken
  });
  if (options.clientSecret) body.set('client_secret', options.clientSecret);

  const response = await getHttpClient().fetch(tokenUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: body.toString(),
    signal: options.signal
  });
  if (!response.ok) throw new Error(`OAuth token refresh failed (${response.status}).`);
  const tokens = parseTokenResponse(await response.json(), options.refreshToken);
  await options.onToken?.(tokens);
  return tokens;
}

async function exchangeCode(
  code: string,
  tokenUrl: URL,
  redirectUri: string,
  verifier: string | undefined,
  options: OAuthFlowOptions
): Promise<OAuthTokenResult> {
  const body = new URLSearchParams({
    client_id: options.clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri
  });
  if (options.clientSecret) body.set('client_secret', options.clientSecret);
  if (verifier) body.set('code_verifier', verifier);

  const response = await getHttpClient().fetch(tokenUrl.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json'
    },
    body: body.toString(),
    signal: options.signal
  });
  if (!response.ok) throw new Error(`OAuth token exchange failed (${response.status}).`);
  const tokens = parseTokenResponse(await response.json());
  await options.onToken?.(tokens);
  return tokens;
}

function parseTokenResponse(payload: unknown, previousRefreshToken?: string): OAuthTokenResult {
  if (!payload || typeof payload !== 'object') throw new Error('OAuth token response must be an object.');
  const result = payload as Record<string, unknown>;
  if (typeof result.access_token !== 'string' || result.access_token.length === 0) {
    throw new Error('OAuth token response did not include an access token.');
  }
  const refreshToken = typeof result.refresh_token === 'string' ? result.refresh_token : previousRefreshToken;
  if (result.expires_in !== undefined && (!Number.isFinite(result.expires_in) || Number(result.expires_in) < 0)) {
    throw new Error('OAuth token response contained an invalid expiry.');
  }
  return {
    accessToken: result.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    ...(typeof result.expires_in === 'number' ? { expiresIn: result.expires_in } : {}),
    ...(typeof result.token_type === 'string' ? { tokenType: result.token_type } : {}),
    ...(typeof result.scope === 'string' ? { scope: result.scope } : {})
  };
}

function validateEndpoint(value: string, name: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(`Invalid ${name}: '${value}'`, { cause: error });
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new Error(`${name} must use HTTPS, except for loopback development endpoints.`);
  }
  if (url.username || url.password) throw new Error(`${name} must not contain credentials.`);
  return url;
}

function normalizeRedirectPath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('?') || path.includes('#')) {
    throw new Error('OAuth redirectPath must be an absolute path without query or fragment.');
  }
  return path;
}

function createAbortError(): Error {
  const error = new Error('OAuth flow aborted');
  error.name = 'AbortError';
  return error;
}
