import { createSign, generateKeyPairSync } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { describe, expect, it } from 'vitest';
import { ChatGPTPlanRuntime } from '../packages/server/src/chatgpt-plan-runtime.js';
import type { RuntimeCredentialStore } from '../packages/server/src/runtime-credential-broker.js';

const OPENID_URL = 'https://auth.openai.com/.well-known/openid-configuration';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const JWKS_URL = 'https://auth.openai.com/oauth/jwks';
const REVOCATION_URL = 'https://auth.openai.com/oauth/revoke';
const MODEL_URL = 'https://api.openai.com/v1/models';
const ACCOUNT_INDEX_REF = 'inkpi.model.openai-chatgpt-plan.accounts';
const ACCOUNT_REF_PREFIX = 'inkpi.model.openai-chatgpt-plan.account.';
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', alg: 'RS256', use: 'sig' };

function createStore(): { store: RuntimeCredentialStore; values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      get: async (reference) => values.get(reference),
      set: async (reference, value) => {
        values.set(reference, value);
      },
      remove: async (reference) => {
        values.delete(reference);
      }
    }
  };
}

function createFixture() {
  const { store, values } = createStore();
  const nonceByCode = new Map<string, string>();
  const subjectByClientId = new Map<string, string>();
  const authorizationCodeGrants: Array<{ code: string; clientId: string; codeVerifier: string }> = [];
  const refreshGrants: Array<{ refreshToken: string; clientId: string }> = [];
  const modelAuthorizationHeaders: string[] = [];
  let now = Date.now();
  let revocationFailures = 0;
  let revocationRequests = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url === OPENID_URL) {
      return jsonResponse({
        issuer: 'https://auth.openai.com',
        authorization_endpoint: 'https://auth.openai.com/oauth/authorize',
        token_endpoint: TOKEN_URL,
        jwks_uri: JWKS_URL,
        revocation_endpoint: REVOCATION_URL
      });
    }
    if (url === JWKS_URL) return jsonResponse({ keys: [publicJwk] });
    if (url === TOKEN_URL) {
      const form = new URLSearchParams(String(init?.body ?? ''));
      const grantType = form.get('grant_type');
      const clientId = form.get('client_id') ?? '';
      if (grantType === 'authorization_code') {
        const code = form.get('code') ?? '';
        const nonce = nonceByCode.get(code) ?? '';
        authorizationCodeGrants.push({
          code,
          clientId,
          codeVerifier: form.get('code_verifier') ?? ''
        });
        const subject = subjectByClientId.get(clientId) ?? `subject-${code}`;
        subjectByClientId.set(clientId, subject);
        const identityLabel = subject.replace(/^subject-/, '');
        const idToken = createIdToken({
          audience: clientId,
          subject,
          nonce: code === 'bad-nonce' ? `${nonce}-wrong` : nonce,
          email: `${identityLabel}@example.test`,
          name: `Account ${identityLabel}`
        });
        const scopes =
          code === 'identity-only'
            ? 'openid profile email offline_access'
            : 'openid profile email offline_access chatgpt.tokens.use.direct';
        return jsonResponse({
          access_token: `access-${code}`,
          refresh_token: `refresh-${code}`,
          id_token: idToken,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: scopes
        });
      }
      if (grantType === 'refresh_token') {
        const refreshToken = form.get('refresh_token') ?? '';
        refreshGrants.push({ refreshToken, clientId });
        const suffix = refreshToken.replace(/^refresh-/, '').replace(/^rotated-/, '');
        return jsonResponse({
          access_token: `refreshed-${suffix}`,
          refresh_token: `rotated-${suffix}`,
          token_type: 'Bearer',
          expires_in: 3600,
          scope: 'openid profile email offline_access chatgpt.tokens.use.direct'
        });
      }
      return jsonResponse({ error: 'unsupported_grant_type' }, 400);
    }
    if (url === MODEL_URL) {
      modelAuthorizationHeaders.push(new Headers(init?.headers).get('authorization') ?? '');
      const token = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
      const suffix = token.replace(/^(?:access-|refreshed-)/, '');
      return jsonResponse({
        models: [
          { slug: `model-${suffix}`, display_name: `Model ${suffix}`, visibility: 'list' },
          { slug: 'hidden-model', display_name: 'Hidden', visibility: 'private' },
          { slug: `model-${suffix}`, display_name: `Duplicate ${suffix}`, visibility: 'list' }
        ]
      });
    }
    if (url === REVOCATION_URL) {
      revocationRequests += 1;
      if (revocationFailures > 0) {
        revocationFailures -= 1;
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 200 });
    }
    throw new Error(`Unexpected fake network request: ${url}`);
  };

  const runtime = new ChatGPTPlanRuntime({
    credentialStore: store,
    fetchImpl,
    now: () => now,
    sleep: async () => {}
  });

  return {
    runtime,
    values,
    authorizationCodeGrants,
    refreshGrants,
    modelAuthorizationHeaders,
    nonceByCode,
    setNow: (value: number) => {
      now = value;
    },
    failNextRevocations: (count: number) => {
      revocationFailures = count;
    },
    get revocationRequests() {
      return revocationRequests;
    }
  };
}

async function finishSignIn(
  fixture: ReturnType<typeof createFixture>,
  attemptId: string,
  authorizationUrl: string,
  code: string,
  issuedClientId = `client-${code}`
) {
  const auth = new URL(authorizationUrl);
  const nonce = auth.searchParams.get('nonce');
  const state = auth.searchParams.get('state');
  const redirectUri = auth.searchParams.get('redirect_uri');
  if (!nonce || !state || !redirectUri) throw new Error('Authorization URL omitted required flow parameters.');
  fixture.nonceByCode.set(code, nonce);

  const rejected = new URL(redirectUri);
  rejected.searchParams.set('state', 'invalid-state');
  expect(await requestLocalCallback(rejected)).toBe(400);
  expect(fixture.runtime.signInStatus({ attemptId }).status).toBe('pending');

  const callback = new URL(redirectUri);
  callback.searchParams.set('code', code);
  callback.searchParams.set('state', state);
  callback.searchParams.set('client_id', issuedClientId);
  expect(await requestLocalCallback(callback)).toBe(200);

  for (let index = 0; index < 100; index += 1) {
    const status = fixture.runtime.signInStatus({ attemptId });
    if (status.status !== 'pending') return status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('ChatGPT sign-in did not settle in the test timeout.');
}

function requestLocalCallback(callback: URL): Promise<number> {
  if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/auth/callback') {
    throw new Error('Test callback must target the Runtime loopback listener.');
  }
  const port = Number(callback.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Test callback must use a valid ephemeral loopback port.');
  }
  return new Promise((resolve, reject) => {
    const request = httpGet(
      {
        hostname: '127.0.0.1',
        port,
        path: `${callback.pathname}${callback.search}`
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      }
    );
    request.setTimeout(2_000, () => request.destroy(new Error('Loopback callback request timed out.')));
    request.once('error', reject);
  });
}

function createIdToken(claims: {
  audience: string;
  subject: string;
  nonce: string;
  email: string;
  name: string;
}): string {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }));
  const payload = encodeBase64Url(
    JSON.stringify({
      iss: 'https://auth.openai.com',
      aud: claims.audience,
      sub: claims.subject,
      iat: nowSeconds,
      exp: nowSeconds + 300,
      nonce: claims.nonce,
      email: claims.email,
      name: claims.name
    })
  );
  const signingInput = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(privateKey).toString('base64url')}`;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

describe('ChatGPT plan Runtime account flow', () => {
  it('isolates parallel account registrations, validates callback state, refreshes tokens, and lists per-account models', async () => {
    const fixture = createFixture();
    try {
      const [firstStart, secondStart] = await Promise.all([
        fixture.runtime.startSignIn({ enablePlanUsage: true }),
        fixture.runtime.startSignIn({ enablePlanUsage: true })
      ]);
      const firstUrl = new URL(firstStart.authorizationUrl);
      const secondUrl = new URL(secondStart.authorizationUrl);
      expect(firstUrl.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(secondUrl.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(firstUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(firstUrl.searchParams.get('scope')).toContain('offline_access');
      expect(firstUrl.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
      expect(firstUrl.searchParams.get('resource')).toBe('https://api.openai.com/v1');
      expect(firstUrl.searchParams.get('ext_agent_host_id')).toBe(secondUrl.searchParams.get('ext_agent_host_id'));

      const [firstStatus, secondStatus] = await Promise.all([
        finishSignIn(fixture, firstStart.attemptId, firstStart.authorizationUrl, 'first'),
        finishSignIn(fixture, secondStart.attemptId, secondStart.authorizationUrl, 'second')
      ]);
      expect(firstStatus.status).toBe('connected');
      expect(secondStatus.status).toBe('connected');
      const status = await fixture.runtime.getStatus();
      expect(status.available).toBe(true);
      expect(status.accounts).toHaveLength(2);
      expect(new Set(status.accounts.map((account) => account.accountId)).size).toBe(2);
      expect(JSON.stringify(status)).not.toContain('access-first');
      expect(JSON.stringify(status)).not.toContain('refresh-first');
      expect(JSON.parse(fixture.values.get(ACCOUNT_INDEX_REF) ?? '[]')).toHaveLength(2);

      const firstAccount = status.accounts.find((account) => account.email === 'first@example.test');
      const secondAccount = status.accounts.find((account) => account.email === 'second@example.test');
      if (!firstAccount || !secondAccount) throw new Error('Expected both accounts in Runtime status.');
      expect(fixture.authorizationCodeGrants.map((grant) => grant.clientId).sort()).toEqual([
        'client-first',
        'client-second'
      ]);
      expect(fixture.authorizationCodeGrants.every((grant) => grant.codeVerifier.length >= 43)).toBe(true);

      fixture.setNow(Date.now() + 3_550_000);
      const [firstModels, secondModels] = await Promise.all([
        fixture.runtime.listModels({ accountId: firstAccount.accountId }),
        fixture.runtime.listModels({ accountId: secondAccount.accountId })
      ]);
      expect(firstModels).toEqual([{ accountId: firstAccount.accountId, id: 'model-first', name: 'Model first' }]);
      expect(secondModels).toEqual([{ accountId: secondAccount.accountId, id: 'model-second', name: 'Model second' }]);
      expect(fixture.modelAuthorizationHeaders.sort()).toEqual(['Bearer refreshed-first', 'Bearer refreshed-second']);
      expect(fixture.refreshGrants.map((grant) => grant.refreshToken).sort()).toEqual([
        'refresh-first',
        'refresh-second'
      ]);
      for (const account of [firstAccount, secondAccount]) {
        const stored = JSON.parse(fixture.values.get(`${ACCOUNT_REF_PREFIX}${account.accountId}`) ?? '{}');
        expect(stored.refreshToken).toBe(`rotated-${account.email?.split('@')[0]}`);
      }
    } finally {
      fixture.runtime.dispose();
    }
  });

  it('reuses the selected account registration and rejects an ID token with a mismatched nonce', async () => {
    const fixture = createFixture();
    try {
      const initial = await fixture.runtime.startSignIn({ enablePlanUsage: true });
      const initialStatus = await finishSignIn(fixture, initial.attemptId, initial.authorizationUrl, 'existing');
      expect(initialStatus.status).toBe('connected');
      if (initialStatus.status !== 'connected') throw new Error('Expected initial account connection.');

      const reauth = await fixture.runtime.startSignIn({
        accountId: initialStatus.account.accountId,
        enablePlanUsage: true
      });
      const reauthUrl = new URL(reauth.authorizationUrl);
      expect(reauthUrl.searchParams.get('client_id')).toBe('client-existing');
      expect(reauthUrl.searchParams.has('id_token_hint')).toBe(true);
      const reauthStatus = await finishSignIn(
        fixture,
        reauth.attemptId,
        reauth.authorizationUrl,
        'reauth',
        'client-existing'
      );
      expect(reauthStatus.status).toBe('connected');
      expect(fixture.authorizationCodeGrants.at(-1)?.clientId).toBe('client-existing');

      const bad = await fixture.runtime.startSignIn({ enablePlanUsage: true });
      const badStatus = await finishSignIn(fixture, bad.attemptId, bad.authorizationUrl, 'bad-nonce');
      expect(badStatus).toMatchObject({ status: 'error' });
      expect(await fixture.runtime.getStatus()).toMatchObject({ accounts: [initialStatus.account] });
    } finally {
      fixture.runtime.dispose();
    }
  });

  it('does not grant model access without the direct-token scope and retries remote revocation before local removal', async () => {
    const fixture = createFixture();
    try {
      const identityOnly = await fixture.runtime.startSignIn({ enablePlanUsage: false });
      const identityStatus = await finishSignIn(
        fixture,
        identityOnly.attemptId,
        identityOnly.authorizationUrl,
        'identity-only'
      );
      expect(identityStatus.status).toBe('connected');
      if (identityStatus.status !== 'connected') throw new Error('Expected identity-only account connection.');
      expect(identityStatus.account.sharing).toBe(false);
      await expect(fixture.runtime.listModels({ accountId: identityStatus.account.accountId })).rejects.toThrow(
        'ChatGPT plan usage is not authorized'
      );
      expect(fixture.modelAuthorizationHeaders).toHaveLength(0);

      const accountStart = await fixture.runtime.startSignIn({ enablePlanUsage: true });
      const accountStatus = await finishSignIn(
        fixture,
        accountStart.attemptId,
        accountStart.authorizationUrl,
        'revoke'
      );
      expect(accountStatus.status).toBe('connected');
      if (accountStatus.status !== 'connected') throw new Error('Expected revocation test account.');
      fixture.failNextRevocations(1);
      const disconnected = await fixture.runtime.disconnect({ accountId: accountStatus.account.accountId });
      expect(disconnected).toEqual({ accountId: accountStatus.account.accountId, remoteRevocationConfirmed: true });
      expect(fixture.revocationRequests).toBe(2);
      expect((await fixture.runtime.getStatus()).accounts.map((account) => account.accountId)).toEqual([
        identityStatus.account.accountId
      ]);
      const storedIndex = JSON.parse(fixture.values.get(ACCOUNT_INDEX_REF) ?? '[]') as string[];
      expect(storedIndex).not.toContain(accountStatus.account.accountId);
    } finally {
      fixture.runtime.dispose();
    }
  });
});
