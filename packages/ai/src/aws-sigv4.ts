/**
 * AWS SigV4 纯算法签名实现（基于原生 WebCrypto API）。
 * 零第三方依赖：替代数十兆的 @aws-sdk，支持原生直连 AWS Bedrock Converse / S3。
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface AwsSignRequestOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  datetime?: string; // ISO yyyyMMddTHHmmssZ
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function sha256(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return toHex(hashBuffer);
}

async function hmacSha256(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await globalThis.crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign'
  ]);
  return globalThis.crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

export async function signAwsRequest(options: AwsSignRequestOptions): Promise<Record<string, string>> {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(options.url);
  } catch (error) {
    throw new Error(`Invalid URL for AWS signing: '${options.url}'`, { cause: error });
  }
  const now = options.datetime || new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = now.slice(0, 8);

  const payloadHash = await sha256(options.body || '');
  const headers: Record<string, string> = {
    host: parsedUrl.host,
    'x-amz-date': now,
    'x-amz-content-sha256': payloadHash,
    ...options.headers
  };

  if (options.credentials.sessionToken) {
    headers['x-amz-security-token'] = options.credentials.sessionToken;
  }

  // Canonical headers
  const sortedHeaderKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders = sortedHeaderKeys.map((k) => `${k}:${headers[k].trim()}\n`).join('');
  const signedHeaders = sortedHeaderKeys.join(';');

  const canonicalRequest = [
    options.method.toUpperCase(),
    parsedUrl.pathname || '/',
    parsedUrl.search ? parsedUrl.search.slice(1) : '',
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');

  const credentialScope = `${dateStamp}/${options.region}/${options.service}/aws4_request`;
  const canonicalRequestHash = await sha256(canonicalRequest);

  const stringToSign = ['AWS4-HMAC-SHA256', now, credentialScope, canonicalRequestHash].join('\n');

  // Derive signing key
  const kSecret = new TextEncoder().encode(`AWS4${options.credentials.secretAccessKey}`);
  const kDate = await hmacSha256(kSecret, dateStamp);
  const kRegion = await hmacSha256(kDate, options.region);
  const kService = await hmacSha256(kRegion, options.service);
  const kSigning = await hmacSha256(kService, 'aws4_request');

  const signature = toHex(await hmacSha256(kSigning, stringToSign));

  const authHeader = `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    ...headers,
    Authorization: authHeader
  };
}
