import { createServer } from 'node:http';
import { getHttpClient } from './http-client.js';

export interface OAuthFlowOptions {
  clientId: string;
  clientSecret?: string;
  authorizationUrl: string;
  tokenUrl: string;
  scopes: string[];
  port?: number;
  redirectPath?: string;
  signal?: AbortSignal;
}

export interface OAuthTokenResult {
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  tokenType?: string;
  scope?: string;
}

/**
 * 生成给用户在浏览器中打开的授权链接
 */
export function getOAuthAuthorizeUrl(options: OAuthFlowOptions, redirectUri: string, state: string): string {
  let url: URL;
  try {
    url = new URL(options.authorizationUrl);
  } catch (error) {
    throw new Error(`Invalid authorizationUrl: '${options.authorizationUrl}'`, { cause: error });
  }
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', options.scopes.join(' '));
  url.searchParams.set('state', state);
  return url.toString();
}

/**
 * 监听本地端口并执行完整换票流程
 */
export async function startOAuthLoginFlow(
  options: OAuthFlowOptions,
  onPromptUrl?: (url: string) => void
): Promise<OAuthTokenResult> {
  const port = options.port || 18420;
  const redirectPath = options.redirectPath || '/oauth/callback';
  const redirectUri = `http://localhost:${port}${redirectPath}`;
  const state = Math.random().toString(36).slice(2);

  const authUrl = getOAuthAuthorizeUrl(options, redirectUri, state);
  if (onPromptUrl) {
    onPromptUrl(authUrl);
  }

  return new Promise<OAuthTokenResult>((resolve, reject) => {
    const serverInstance = createServer();

    const cleanup = () => {
      serverInstance.close();
    };

    if (options.signal) {
      options.signal.addEventListener('abort', () => {
        cleanup();
        reject(new Error('OAuth flow aborted'));
      });
    }

    serverInstance.on('request', async (req, res) => {
      try {
        if (!req.url?.startsWith(redirectPath)) {
          res.writeHead(404);
          res.end();
          return;
        }

        const reqUrl = new URL(req.url, `http://localhost:${port}`);
        const code = reqUrl.searchParams.get('code');
        const receivedState = reqUrl.searchParams.get('state');

        if (receivedState !== state) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h3>State mismatch! Authorization failed.</h3>');
          cleanup();
          reject(new Error('OAuth state mismatch'));
          return;
        }

        if (!code) {
          res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h3>Missing authorization code.</h3>');
          cleanup();
          reject(new Error('Missing authorization code'));
          return;
        }

        // 向 tokenUrl 发起换票请求
        const bodyParams = new URLSearchParams({
          client_id: options.clientId,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri
        });
        if (options.clientSecret) {
          bodyParams.set('client_secret', options.clientSecret);
        }

        // 校验并限制 tokenUrl 仅允许 HTTPS 或合法 HTTP 协议，防止 SSRF 探针
        const validatedTokenUrl = new URL(options.tokenUrl);
        if (validatedTokenUrl.protocol !== 'https:' && validatedTokenUrl.protocol !== 'http:') {
          throw new Error(`Unsupported OAuth token protocol: ${validatedTokenUrl.protocol}`);
        }

        const tokenRes = await getHttpClient().fetch(validatedTokenUrl.toString(), {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json'
          },
          body: bodyParams.toString()
        });

        if (!tokenRes.ok) {
          const errText = await tokenRes.text();
          res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<h3>Token exchange failed.</h3>');
          cleanup();
          reject(new Error(`Token exchange failed (${tokenRes.status}): ${errText}`));
          return;
        }

        const tokenData = (await tokenRes.json()) as any;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<h3>Authentication successful! You can close this window now.</h3>');
        cleanup();

        resolve({
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresIn: tokenData.expires_in,
          tokenType: tokenData.token_type,
          scope: tokenData.scope
        });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });

    serverInstance.listen(port);
  });
}
