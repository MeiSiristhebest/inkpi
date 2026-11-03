import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  OpenAIChatGPTPlanAccountSummary,
  OpenAIChatGPTPlanConnection,
  OpenAIChatGPTPlanDisconnectParams,
  OpenAIChatGPTPlanDisconnectResult,
  OpenAIChatGPTPlanModel,
  OpenAIChatGPTPlanModelsParams,
  OpenAIChatGPTPlanSignInParams,
  OpenAIChatGPTPlanSignInStart,
  OpenAIChatGPTPlanSignInStatus,
  OpenAIChatGPTPlanSignInStatusParams,
  RuntimeModelCatalogEntry,
  RuntimeModelProviderProbeParams,
  RuntimeModelProviderProbeResult
} from '@inkpi/protocol';
import { type JWK, decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import type { RuntimeCredentialStore } from './runtime-credential-broker.js';

const OPENID_CONFIGURATION_URL = 'https://auth.openai.com/.well-known/openid-configuration';
const OPENAI_RESOURCE = 'https://api.openai.com/v1';
const OPENAI_MODELS_URL = `${OPENAI_RESOURCE}/models`;
const OPENAI_TOKEN_SCOPE = 'chatgpt.tokens.use.direct';
const DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
type OpenAIAccountNamespace = 'openai-chatgpt-plan' | 'openai-codex';
const CALLBACK_PATH = '/auth/callback';
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000;
const ATTEMPT_RETENTION_MS = 10 * 60 * 1000;
const MAX_PENDING_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
type SupportedJwtAlgorithm = 'RS256' | 'ES256' | 'EdDSA';
const ALLOWED_JWT_ALGORITHMS: readonly SupportedJwtAlgorithm[] = ['RS256', 'ES256', 'EdDSA'];

interface OpenIdConfiguration {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  revocationEndpoint: string;
}

interface ChatGPTPlanAccountRecord {
  version: 1;
  accountId: string;
  subject: string;
  email?: string;
  name?: string;
  clientId: string;
  hostId: string;
  idToken: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  earliestRefreshAt?: number;
  scopes: string[];
  createdAt: number;
}

interface OAuthTokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  earliest_refresh_at?: string | number;
  error?: string;
}

interface SignInAttempt {
  attemptId: string;
  state: string;
  nonce: string;
  verifier: string;
  redirectUri: string;
  accountId?: string;
  clientId?: string;
  idTokenHint?: string;
  loginHint?: string;
  hostId: string;
  enablePlanUsage: boolean;
  server: Server;
  result?: OpenAIChatGPTPlanSignInStatus;
  timer?: NodeJS.Timeout;
  handlingCallback: boolean;
  createdAt: number;
  completedAt?: number;
}

export interface ChatGPTPlanRuntimeOptions {
  credentialStore?: RuntimeCredentialStore;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Separate persisted OAuth namespace for the Codex route. */
  accountNamespace?: OpenAIAccountNamespace;
}

/** Implements OpenAI's documented Sign in with ChatGPT plan-usage flow. */
export class ChatGPTPlanRuntime {
  private readonly credentialStore?: RuntimeCredentialStore;
  private readonly accountNamespace: OpenAIAccountNamespace;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly attempts = new Map<string, SignInAttempt>();
  private readonly refreshes = new Map<string, Promise<string>>();
  private accountMutation: Promise<void> = Promise.resolve();
  private hostIdPromise?: Promise<string>;
  private openIdConfiguration?: Promise<OpenIdConfiguration>;

  constructor(options: ChatGPTPlanRuntimeOptions = {}) {
    this.credentialStore = options.credentialStore;
    this.accountNamespace = options.accountNamespace ?? 'openai-chatgpt-plan';
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async getStatus(): Promise<OpenAIChatGPTPlanConnection> {
    if (!this.credentialStore) return { available: false, accounts: [] };
    const accountIds = await this.readAccountIds();
    const records = await Promise.all(accountIds.map((accountId) => this.readAccount(accountId)));
    return {
      available: true,
      accounts: records.flatMap((record) => (record ? [toAccountSummary(record)] : []))
    };
  }

  async startSignIn(params: OpenAIChatGPTPlanSignInParams): Promise<OpenAIChatGPTPlanSignInStart> {
    const store = this.requireCredentialStore();
    if (this.accountNamespace === 'openai-codex' && params.enablePlanUsage) {
      throw new ChatGPTPlanRuntimeError('Codex sign-in does not support ChatGPT Plan token access.');
    }
    this.pruneAttempts();
    if ([...this.attempts.values()].filter((attempt) => !attempt.result).length >= MAX_PENDING_ATTEMPTS) {
      throw new ChatGPTPlanRuntimeError('Too many sign-in attempts are already pending.');
    }

    const accountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
    const existing = accountId ? await this.readAccount(accountId) : undefined;
    if (accountId && !existing) throw new ChatGPTPlanRuntimeError('The selected ChatGPT account no longer exists.');
    const hostId = await this.getOrCreateHostId(store);
    const openId = await this.getOpenIdConfiguration();
    const state = randomBytes(32).toString('base64url');
    const nonce = randomBytes(32).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    const attemptId = randomBytes(16).toString('hex');
    const server = createServer();
    await listenOnLoopback(server);
    const address = server.address() as AddressInfo | null;
    if (!address || typeof address === 'string') {
      server.close();
      throw new ChatGPTPlanRuntimeError('Could not start the local ChatGPT sign-in callback.');
    }

    const redirectUri = `http://127.0.0.1:${address.port}${CALLBACK_PATH}`;
    const attempt: SignInAttempt = {
      attemptId,
      state,
      nonce,
      verifier,
      redirectUri,
      ...(existing ? { accountId: existing.accountId, clientId: existing.clientId } : {}),
      ...(existing?.idToken ? { idTokenHint: existing.idToken } : {}),
      ...(existing?.email ? { loginHint: existing.email } : {}),
      hostId,
      enablePlanUsage: params.enablePlanUsage,
      server,
      handlingCallback: false,
      createdAt: this.now()
    };
    server.on('request', (request, response) => this.handleCallback(attempt, request, response));
    attempt.timer = setTimeout(() => {
      if (attempt.result || attempt.handlingCallback) return;
      this.setAttemptResult(attempt, {
        status: 'error',
        message: 'The ChatGPT sign-in attempt expired. Please try again.'
      });
      server.close();
    }, SIGN_IN_TIMEOUT_MS);
    attempt.timer.unref?.();
    this.attempts.set(attemptId, attempt);

    let authorizationUrl: URL;
    try {
      authorizationUrl = new URL(openId.authorizationEndpoint);
    } catch {
      server.close();
      this.attempts.delete(attemptId);
      throw new ChatGPTPlanRuntimeError('OpenAI authorization metadata is invalid.');
    }
    authorizationUrl.searchParams.set('client_id', existing?.clientId ?? DYNAMIC_CLIENT_ID);
    authorizationUrl.searchParams.set('response_type', 'code');
    authorizationUrl.searchParams.set('redirect_uri', redirectUri);
    authorizationUrl.searchParams.set('scope', requestedScopes(params.enablePlanUsage));
    authorizationUrl.searchParams.set('state', state);
    authorizationUrl.searchParams.set('nonce', nonce);
    authorizationUrl.searchParams.set('code_challenge_method', 'S256');
    authorizationUrl.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'));
    authorizationUrl.searchParams.set('ext_agent_host_id', hostId);
    if (params.enablePlanUsage) authorizationUrl.searchParams.set('resource', OPENAI_RESOURCE);
    if (existing) {
      if (existing.idToken) authorizationUrl.searchParams.set('id_token_hint', existing.idToken);
      if (existing.email) authorizationUrl.searchParams.set('login_hint', existing.email);
    } else {
      authorizationUrl.searchParams.set('agent_name_hint', 'InkPi');
    }

    return { attemptId, authorizationUrl: authorizationUrl.toString() };
  }

  signInStatus(params: OpenAIChatGPTPlanSignInStatusParams): OpenAIChatGPTPlanSignInStatus {
    this.pruneAttempts();
    const attempt = this.attempts.get(params.attemptId);
    if (!attempt) throw new ChatGPTPlanRuntimeError('The ChatGPT sign-in attempt is no longer available.');
    return attempt.result ?? { status: 'pending' };
  }

  async listModels(params: OpenAIChatGPTPlanModelsParams): Promise<OpenAIChatGPTPlanModel[]> {
    if (this.accountNamespace !== 'openai-chatgpt-plan') {
      throw new ChatGPTPlanRuntimeError('Codex model discovery is not available through the ChatGPT Plan API.');
    }
    const accountId = normalizeAccountId(params.accountId);
    const accessToken = await this.getAccessTokenForAccount(accountId, true);
    let response: Response;
    try {
      response = await this.fetchImpl(OPENAI_MODELS_URL, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${accessToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new ChatGPTPlanRuntimeError('OpenAI model list request could not reach the API.');
    }
    if (!response.ok) throw new ChatGPTPlanRuntimeError(`OpenAI model list request failed (HTTP ${response.status}).`);
    const payload = await readJson(response);
    if (!isRecord(payload) || !Array.isArray(payload.models)) return [];

    const models: OpenAIChatGPTPlanModel[] = [];
    const seen = new Set<string>();
    for (const entry of payload.models) {
      if (!isRecord(entry) || entry.visibility !== 'list') continue;
      const id = safeDisplayString(entry.slug);
      const name = safeDisplayString(entry.display_name);
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      models.push({ accountId, id, name });
    }
    return models;
  }

  async disconnect(params: OpenAIChatGPTPlanDisconnectParams): Promise<OpenAIChatGPTPlanDisconnectResult> {
    const accountId = normalizeAccountId(params.accountId);
    const account = await this.readAccount(accountId);
    if (!account) return { accountId, remoteRevocationConfirmed: false };
    const remoteRevocationConfirmed = account.refreshToken ? await this.revokeRefreshToken(account) : false;
    await this.removeAccount(accountId);
    return { accountId, remoteRevocationConfirmed };
  }

  async probeModelProvider(params: RuntimeModelProviderProbeParams): Promise<RuntimeModelProviderProbeResult> {
    if (this.accountNamespace !== 'openai-chatgpt-plan') {
      throw new ChatGPTPlanRuntimeError('Codex accounts use the OpenAI Codex Responses route.');
    }
    const accountId = accountIdFromCredentialRef(params.credentialRef, this.accountNamespace);
    const startedAt = this.now();
    const models = await this.listModels({ accountId });
    const catalogModels: RuntimeModelCatalogEntry[] = models.map(({ id, name }) => ({ id, name }));
    return {
      status: 200,
      latency: Math.max(0, this.now() - startedAt),
      modelIds: models.map((model) => model.id),
      catalogModels
    };
  }

  /** Resolve an account-scoped route reference without returning any token to Desktop. */
  async resolveModelAccessToken(credentialRef: string): Promise<string> {
    return this.getAccessTokenForAccount(
      accountIdFromCredentialRef(credentialRef, this.accountNamespace),
      this.accountNamespace === 'openai-chatgpt-plan'
    );
  }

  dispose(): void {
    for (const attempt of this.attempts.values()) {
      if (attempt.timer) clearTimeout(attempt.timer);
      attempt.server.close();
    }
    this.attempts.clear();
  }

  private async handleCallback(
    attempt: SignInAttempt,
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    if (request.method !== 'GET' || !request.url || request.url.length > 4096) {
      sendCallbackResponse(response, 400);
      return;
    }
    let callback: URL;
    try {
      callback = new URL(request.url, attempt.redirectUri);
    } catch {
      sendCallbackResponse(response, 400);
      return;
    }
    if (callback.pathname !== CALLBACK_PATH) {
      sendCallbackResponse(response, 404);
      return;
    }
    if (!constantTimeStringEqual(callback.searchParams.get('state') ?? '', attempt.state)) {
      sendCallbackResponse(response, 400);
      return;
    }
    if (attempt.result || attempt.handlingCallback) {
      sendCallbackResponse(response, 409);
      return;
    }

    attempt.handlingCallback = true;
    if (attempt.timer) clearTimeout(attempt.timer);
    sendCallbackResponse(response, 200);
    attempt.server.close();

    const oauthError = callback.searchParams.get('error');
    if (oauthError) {
      this.setAttemptResult(
        attempt,
        oauthError === 'access_denied'
          ? { status: 'cancelled', message: 'ChatGPT sign-in was cancelled.' }
          : { status: 'error', message: 'OpenAI did not complete the sign-in request.' }
      );
      return;
    }

    const code = callback.searchParams.get('code');
    if (!code) {
      this.setAttemptResult(attempt, { status: 'error', message: 'OpenAI returned no authorization code.' });
      return;
    }

    try {
      const account = await this.completeSignIn(attempt, code, callback.searchParams.get('client_id'));
      this.setAttemptResult(attempt, { status: 'connected', account: toAccountSummary(account) });
    } catch (error) {
      this.setAttemptResult(attempt, {
        status: 'error',
        message: error instanceof ChatGPTPlanRuntimeError ? error.message : 'ChatGPT sign-in could not be completed.'
      });
    }
  }

  private async completeSignIn(
    attempt: SignInAttempt,
    code: string,
    callbackClientId: string | null
  ): Promise<ChatGPTPlanAccountRecord> {
    const store = this.requireCredentialStore();
    const openId = await this.getOpenIdConfiguration();
    const clientId = attempt.clientId ?? requireIssuedClientId(callbackClientId);
    if (attempt.clientId && callbackClientId && callbackClientId !== attempt.clientId) {
      throw new ChatGPTPlanRuntimeError('OpenAI returned a different client registration for this account.');
    }
    const tokens = await this.exchangeAuthorizationCode(openId, {
      clientId,
      code,
      codeVerifier: attempt.verifier,
      redirectUri: attempt.redirectUri,
      includeResource: attempt.enablePlanUsage
    });
    const scopes = parseScopes(tokens.scope);
    const identity = await this.validateIdToken(openId, tokens.id_token ?? '', clientId, attempt.nonce);
    const existing = attempt.accountId ? await this.readAccount(attempt.accountId) : undefined;
    if (existing && existing.subject !== identity.subject) {
      throw new ChatGPTPlanRuntimeError('The signed-in ChatGPT identity does not match the selected account.');
    }

    const accountId = existing?.accountId ?? randomBytes(16).toString('hex');
    const idToken = tokens.id_token;
    if (!idToken) throw new ChatGPTPlanRuntimeError('OpenAI returned no identity token.');
    const earliestRefreshAt = parseRefreshTime(tokens.earliest_refresh_at);
    const account: ChatGPTPlanAccountRecord = {
      version: 1,
      accountId,
      subject: identity.subject,
      ...(identity.email || existing?.email ? { email: identity.email ?? existing?.email } : {}),
      ...(identity.name || existing?.name ? { name: identity.name ?? existing?.name } : {}),
      clientId,
      hostId: attempt.hostId,
      idToken,
      accessToken: tokens.access_token,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      expiresAt: this.now() + tokens.expires_in * 1000,
      ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}),
      scopes,
      createdAt: existing?.createdAt ?? this.now()
    };
    await this.saveAccount(store, account);
    return account;
  }

  private async exchangeAuthorizationCode(
    openId: OpenIdConfiguration,
    params: {
      clientId: string;
      code: string;
      codeVerifier: string;
      redirectUri: string;
      includeResource: boolean;
    }
  ): Promise<OAuthTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: params.clientId,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
      ...(params.includeResource ? { resource: OPENAI_RESOURCE } : {})
    });
    const response = await this.fetchImpl(openId.tokenEndpoint, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const payload = await readJson(response);
    if (!response.ok) {
      throw new ChatGPTPlanRuntimeError(`OpenAI token exchange failed (HTTP ${response.status}).`);
    }
    return validateTokenResponse(payload, true);
  }

  private async validateIdToken(
    openId: OpenIdConfiguration,
    token: string,
    clientId: string,
    expectedNonce: string
  ): Promise<{ subject: string; email?: string; name?: string }> {
    if (!token) throw new ChatGPTPlanRuntimeError('OpenAI returned no identity token.');
    let header: ReturnType<typeof decodeProtectedHeader>;
    try {
      header = decodeProtectedHeader(token);
    } catch {
      throw new ChatGPTPlanRuntimeError('OpenAI returned an invalid identity token.');
    }
    if (typeof header.kid !== 'string' || typeof header.alg !== 'string') {
      throw new ChatGPTPlanRuntimeError('OpenAI returned an invalid identity token header.');
    }
    const algorithm = header.alg as SupportedJwtAlgorithm;
    if (!ALLOWED_JWT_ALGORITHMS.includes(algorithm)) {
      throw new ChatGPTPlanRuntimeError('OpenAI returned an unsupported identity-token signature.');
    }
    const jwksPayload = await this.fetchJson(openId.jwksUri);
    if (!isRecord(jwksPayload) || !Array.isArray(jwksPayload.keys)) {
      throw new ChatGPTPlanRuntimeError('OpenAI identity keys could not be validated.');
    }
    const jwkValue = jwksPayload.keys.find((candidate) => isRecord(candidate) && candidate.kid === header.kid);
    if (!isRecord(jwkValue)) throw new ChatGPTPlanRuntimeError('OpenAI identity keys could not be validated.');

    try {
      const key = await importJWK(jwkValue as JWK, algorithm);
      const verified = await jwtVerify(token, key, {
        issuer: openId.issuer,
        audience: clientId,
        algorithms: [algorithm]
      });
      if (verified.payload.nonce !== expectedNonce || typeof verified.payload.sub !== 'string') {
        throw new ChatGPTPlanRuntimeError('OpenAI identity-token claims did not match this sign-in attempt.');
      }
      return {
        subject: verified.payload.sub,
        ...(typeof verified.payload.email === 'string' ? { email: verified.payload.email } : {}),
        ...(typeof verified.payload.name === 'string' ? { name: verified.payload.name } : {})
      };
    } catch (error) {
      if (error instanceof ChatGPTPlanRuntimeError) throw error;
      throw new ChatGPTPlanRuntimeError('OpenAI identity-token validation failed.');
    }
  }

  private async getAccessTokenForAccount(accountId: string, requirePlanUsage: boolean): Promise<string> {
    const normalizedId = normalizeAccountId(accountId);
    const account = await this.readAccount(normalizedId);
    if (!account) throw new ChatGPTPlanRuntimeError('The selected ChatGPT account is not connected.');
    if (requirePlanUsage && !account.scopes.includes(OPENAI_TOKEN_SCOPE)) {
      throw new ChatGPTPlanRuntimeError('ChatGPT plan usage is not authorized for this account.');
    }
    const existingRefresh = this.refreshes.get(normalizedId);
    if (existingRefresh) return existingRefresh;
    const now = this.now();
    const expiresAt = account.expiresAt ?? 0;
    const accessTokenExpired = expiresAt <= now;
    const refreshWindowReached = expiresAt <= now + 120_000 && (account.earliestRefreshAt ?? 0) <= now;
    if (!accessTokenExpired && !refreshWindowReached && account.accessToken) return account.accessToken;
    if (!account.refreshToken) {
      if (account.accessToken && !accessTokenExpired) return account.accessToken;
      throw new ChatGPTPlanRuntimeError('This ChatGPT account needs to be signed in again.');
    }

    const refresh = this.refreshAccessToken(account);
    this.refreshes.set(normalizedId, refresh);
    try {
      return await refresh;
    } finally {
      if (this.refreshes.get(normalizedId) === refresh) this.refreshes.delete(normalizedId);
    }
  }

  private async refreshAccessToken(account: ChatGPTPlanAccountRecord): Promise<string> {
    const openId = await this.getOpenIdConfiguration();
    const refreshToken = account.refreshToken;
    if (!refreshToken) throw new ChatGPTPlanRuntimeError('This ChatGPT account needs to be signed in again.');
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: account.clientId,
      refresh_token: refreshToken,
      ...(this.accountNamespace === 'openai-chatgpt-plan' ? { resource: OPENAI_RESOURCE } : {})
    });
    let response: Response;
    try {
      response = await this.fetchImpl(openId.tokenEndpoint, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new ChatGPTPlanRuntimeError('OpenAI token refresh could not reach the authorization service.');
    }
    const payload = await readJson(response);
    if (!response.ok) {
      if (isUnusableRefreshToken(payload)) {
        await this.saveAccount(this.requireCredentialStore(), {
          ...account,
          accessToken: undefined,
          refreshToken: undefined,
          expiresAt: undefined,
          earliestRefreshAt: undefined
        });
        throw new ChatGPTPlanRuntimeError('This ChatGPT account needs to be signed in again.');
      }
      throw new ChatGPTPlanRuntimeError(`OpenAI token refresh failed (HTTP ${response.status}).`);
    }

    const tokens = validateTokenResponse(payload, false);
    const earliestRefreshAt = parseRefreshTime(tokens.earliest_refresh_at);
    const accessToken = tokens.access_token;
    const refreshed: ChatGPTPlanAccountRecord = {
      ...account,
      accessToken,
      ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
      expiresAt: this.now() + tokens.expires_in * 1000,
      ...(earliestRefreshAt !== undefined ? { earliestRefreshAt } : {}),
      ...(tokens.scope !== undefined ? { scopes: parseScopes(tokens.scope) } : {})
    };
    if (!refreshed.refreshToken) {
      throw new ChatGPTPlanRuntimeError('OpenAI did not rotate the account refresh token.');
    }
    await this.saveAccount(this.requireCredentialStore(), refreshed);
    if (this.accountNamespace === 'openai-chatgpt-plan' && !refreshed.scopes.includes(OPENAI_TOKEN_SCOPE)) {
      throw new ChatGPTPlanRuntimeError('ChatGPT plan usage is not authorized for this account.');
    }
    return accessToken;
  }

  private async revokeRefreshToken(account: ChatGPTPlanAccountRecord): Promise<boolean> {
    let openId: OpenIdConfiguration;
    try {
      openId = await this.getOpenIdConfiguration();
    } catch {
      return false;
    }
    const refreshToken = account.refreshToken;
    if (!refreshToken) return false;
    const body = new URLSearchParams({
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: account.clientId
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const response = await this.fetchImpl(openId.revocationEndpoint, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
        if (response.status === 200) return true;
        if (response.status < 500 || attempt === 2) return false;
      } catch {
        if (attempt === 2) return false;
      }
      await this.sleep(150 * 2 ** attempt);
    }
    return false;
  }

  private saveAccount(store: RuntimeCredentialStore, account: ChatGPTPlanAccountRecord): Promise<void> {
    return this.withAccountMutation(async () => {
      const reference = accountCredentialRef(account.accountId, this.accountNamespace);
      const previousRecord = await store.get(reference);
      const accountIds = await this.readAccountIds();
      const nextIds = accountIds.includes(account.accountId) ? accountIds : [...accountIds, account.accountId];
      await store.set(reference, JSON.stringify(account));
      try {
        await store.set(accountIndexRef(this.accountNamespace), JSON.stringify(nextIds));
      } catch (error) {
        try {
          if (previousRecord) await store.set(reference, previousRecord);
          else await store.remove(reference);
        } catch {
          // Preserve the original write error; the record can be recovered from its account ref.
        }
        throw error;
      }
    });
  }

  private removeAccount(accountId: string): Promise<void> {
    return this.withAccountMutation(async () => {
      const store = this.requireCredentialStore();
      const reference = accountCredentialRef(accountId, this.accountNamespace);
      const previousRecord = await store.get(reference);
      const nextIds = (await this.readAccountIds()).filter((id) => id !== accountId);
      await store.remove(reference);
      try {
        if (nextIds.length > 0) await store.set(accountIndexRef(this.accountNamespace), JSON.stringify(nextIds));
        else await store.remove(accountIndexRef(this.accountNamespace));
      } catch (error) {
        if (previousRecord) {
          try {
            await store.set(reference, previousRecord);
          } catch {
            // Preserve the original index update error.
          }
        }
        throw error;
      }
    });
  }

  private async readAccountIds(): Promise<string[]> {
    const raw = await this.requireCredentialStore().get(accountIndexRef(this.accountNamespace));
    if (!raw) return [];
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ChatGPTPlanRuntimeError('The saved ChatGPT account index is invalid.');
    }
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && ACCOUNT_ID_PATTERN.test(entry))) {
      throw new ChatGPTPlanRuntimeError('The saved ChatGPT account index is invalid.');
    }
    return [...new Set(value.map((entry: string) => entry.toLowerCase()))];
  }

  private async readAccount(accountId: string): Promise<ChatGPTPlanAccountRecord | undefined> {
    const normalizedId = normalizeAccountId(accountId);
    const raw = await this.requireCredentialStore().get(accountCredentialRef(normalizedId, this.accountNamespace));
    if (!raw) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new ChatGPTPlanRuntimeError('A saved ChatGPT account record is invalid.');
    }
    if (!isAccountRecord(value) || value.accountId !== normalizedId) {
      throw new ChatGPTPlanRuntimeError('A saved ChatGPT account record is invalid.');
    }
    return value;
  }

  private getOrCreateHostId(store: RuntimeCredentialStore): Promise<string> {
    if (!this.hostIdPromise) {
      this.hostIdPromise = (async () => {
        const reference = hostIdRef(this.accountNamespace);
        const existing = await store.get(reference);
        if (existing) {
          if (!/^urn:uuid:[0-9a-f-]{36}$/i.test(existing)) {
            throw new ChatGPTPlanRuntimeError('The saved ChatGPT host identifier is invalid.');
          }
          return existing;
        }
        const hostId = `urn:uuid:${randomUUID()}`;
        await store.set(reference, hostId);
        return hostId;
      })().catch((error) => {
        this.hostIdPromise = undefined;
        throw error;
      });
    }
    return this.hostIdPromise;
  }

  private async withAccountMutation<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.accountMutation;
    let release = () => {};
    this.accountMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private requireCredentialStore(): RuntimeCredentialStore {
    if (!this.credentialStore) throw new ChatGPTPlanRuntimeError('The Desktop credential broker is unavailable.');
    return this.credentialStore;
  }

  private async getOpenIdConfiguration(): Promise<OpenIdConfiguration> {
    if (!this.openIdConfiguration) {
      this.openIdConfiguration = this.fetchOpenIdConfiguration().catch((error) => {
        this.openIdConfiguration = undefined;
        throw error;
      });
    }
    return this.openIdConfiguration;
  }

  private async fetchOpenIdConfiguration(): Promise<OpenIdConfiguration> {
    const payload = await this.fetchJson(OPENID_CONFIGURATION_URL);
    if (!isRecord(payload) || payload.issuer !== 'https://auth.openai.com') {
      throw new ChatGPTPlanRuntimeError('OpenAI authorization metadata is invalid.');
    }
    return {
      issuer: payload.issuer,
      authorizationEndpoint: trustedAuthEndpoint(payload.authorization_endpoint),
      tokenEndpoint: trustedAuthEndpoint(payload.token_endpoint),
      jwksUri: trustedAuthEndpoint(payload.jwks_uri),
      revocationEndpoint: trustedAuthEndpoint(payload.revocation_endpoint)
    };
  }

  private async fetchJson(url: string): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });
    } catch {
      throw new ChatGPTPlanRuntimeError('OpenAI authorization metadata could not be reached.');
    }
    if (!response.ok)
      throw new ChatGPTPlanRuntimeError(`OpenAI authorization metadata failed (HTTP ${response.status}).`);
    return readJson(response);
  }

  private setAttemptResult(attempt: SignInAttempt, result: OpenAIChatGPTPlanSignInStatus): void {
    if (attempt.timer) clearTimeout(attempt.timer);
    attempt.result = result;
    attempt.completedAt = this.now();
    attempt.handlingCallback = false;
  }

  private pruneAttempts(): void {
    const now = this.now();
    for (const [attemptId, attempt] of this.attempts) {
      if (attempt.completedAt !== undefined && now - attempt.completedAt > ATTEMPT_RETENTION_MS) {
        this.attempts.delete(attemptId);
        if (attempt.timer) clearTimeout(attempt.timer);
      }
    }
  }
}

class ChatGPTPlanRuntimeError extends Error {}

function requestedScopes(enablePlanUsage: boolean): string {
  return enablePlanUsage
    ? 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'
    : 'openid profile email offline_access';
}

function requireIssuedClientId(value: string | null): string {
  if (!value || value === DYNAMIC_CLIENT_ID || value.length > 256 || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new ChatGPTPlanRuntimeError('OpenAI did not return a valid client registration.');
  }
  return value;
}

function trustedAuthEndpoint(value: unknown): string {
  if (typeof value !== 'string') throw new ChatGPTPlanRuntimeError('OpenAI authorization metadata is incomplete.');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ChatGPTPlanRuntimeError('OpenAI authorization metadata is invalid.');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'auth.openai.com' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ChatGPTPlanRuntimeError('OpenAI authorization metadata contains an untrusted endpoint.');
  }
  return url.toString();
}

function normalizeAccountId(accountId: string): string {
  if (!ACCOUNT_ID_PATTERN.test(accountId))
    throw new ChatGPTPlanRuntimeError('The ChatGPT account identifier is invalid.');
  return accountId.toLowerCase();
}

function accountIndexRef(namespace: OpenAIAccountNamespace): string {
  return `inkpi.model.${namespace}.accounts`;
}

function hostIdRef(namespace: OpenAIAccountNamespace): string {
  return `inkpi.model.${namespace}.host`;
}

function accountCredentialRef(accountId: string, namespace: OpenAIAccountNamespace): string {
  return `inkpi.model.${namespace}.account.${normalizeAccountId(accountId)}`;
}

function accountIdFromCredentialRef(credentialRef: string | undefined, namespace: OpenAIAccountNamespace): string {
  const prefix = `inkpi.model.${namespace}.account.`;
  if (!credentialRef?.startsWith(prefix)) {
    throw new ChatGPTPlanRuntimeError('An account-scoped OpenAI credential reference is required.');
  }
  return normalizeAccountId(credentialRef.slice(prefix.length));
}

function isAccountRecord(value: unknown): value is ChatGPTPlanAccountRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.accountId === 'string' &&
    ACCOUNT_ID_PATTERN.test(value.accountId) &&
    typeof value.subject === 'string' &&
    typeof value.clientId === 'string' &&
    typeof value.hostId === 'string' &&
    typeof value.idToken === 'string' &&
    Array.isArray(value.scopes) &&
    value.scopes.every((scope) => typeof scope === 'string') &&
    typeof value.createdAt === 'number' &&
    (value.accessToken === undefined || typeof value.accessToken === 'string') &&
    (value.refreshToken === undefined || typeof value.refreshToken === 'string') &&
    (value.expiresAt === undefined || typeof value.expiresAt === 'number') &&
    (value.earliestRefreshAt === undefined || typeof value.earliestRefreshAt === 'number') &&
    (value.email === undefined || typeof value.email === 'string') &&
    (value.name === undefined || typeof value.name === 'string')
  );
}

function toAccountSummary(account: ChatGPTPlanAccountRecord): OpenAIChatGPTPlanAccountSummary {
  const connected = Boolean(account.accessToken || account.refreshToken);
  const reauthRequired = !account.refreshToken;
  return {
    accountId: account.accountId,
    ...(account.email ? { email: account.email } : {}),
    ...(account.name ? { name: account.name } : {}),
    connected,
    sharing: connected && account.scopes.includes(OPENAI_TOKEN_SCOPE),
    reauthRequired
  };
}

function validateTokenResponse(value: unknown, requireIdToken: boolean): OAuthTokenResponse {
  if (
    !isRecord(value) ||
    typeof value.access_token !== 'string' ||
    !value.access_token ||
    typeof value.token_type !== 'string' ||
    value.token_type.toLowerCase() !== 'bearer' ||
    typeof value.expires_in !== 'number' ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0 ||
    (requireIdToken && typeof value.id_token !== 'string') ||
    (value.id_token !== undefined && (typeof value.id_token !== 'string' || !value.id_token)) ||
    (value.refresh_token !== undefined && (typeof value.refresh_token !== 'string' || !value.refresh_token)) ||
    (value.scope !== undefined && typeof value.scope !== 'string') ||
    (value.earliest_refresh_at !== undefined &&
      typeof value.earliest_refresh_at !== 'string' &&
      typeof value.earliest_refresh_at !== 'number') ||
    (value.error !== undefined && typeof value.error !== 'string')
  ) {
    throw new ChatGPTPlanRuntimeError('OpenAI returned an invalid token response.');
  }
  return {
    access_token: value.access_token,
    token_type: value.token_type,
    expires_in: value.expires_in,
    ...(typeof value.id_token === 'string' ? { id_token: value.id_token } : {}),
    ...(typeof value.refresh_token === 'string' ? { refresh_token: value.refresh_token } : {}),
    ...(typeof value.scope === 'string' ? { scope: value.scope } : {}),
    ...(typeof value.earliest_refresh_at === 'string' || typeof value.earliest_refresh_at === 'number'
      ? { earliest_refresh_at: value.earliest_refresh_at }
      : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {})
  };
}

function parseScopes(scope?: string): string[] {
  return scope ? [...new Set(scope.split(/\s+/).filter(Boolean))] : [];
}

function parseRefreshTime(value: string | number | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return date;
  }
  return undefined;
}

function isUnusableRefreshToken(value: unknown): boolean {
  if (!isRecord(value) || typeof value.error !== 'string') return false;
  return [
    'invalid_grant',
    'invalid_refresh_token',
    'token_expired',
    'refresh_token_expired',
    'refresh_token_invalidated',
    'refresh_token_reused'
  ].includes(value.error);
}

function safeDisplayString(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    return undefined;
  }
  return value.trim();
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ChatGPTPlanRuntimeError('OpenAI returned an invalid JSON response.');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function sendCallbackResponse(response: ServerResponse, status: number): void {
  const completed =
    '<!doctype html><meta charset="utf-8"><title>InkPi</title><p>Sign-in complete. You can return to InkPi.</p>';
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(status === 200 ? completed : 'Sign-in request was rejected. You can return to InkPi.');
}

function listenOnLoopback(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });
}
