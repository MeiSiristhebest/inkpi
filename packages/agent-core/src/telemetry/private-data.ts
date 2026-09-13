const PRIVATE_REASONING_KEYS = new Set([
  'analysis',
  'chainofthought',
  'cot',
  'deliberation',
  'deliberationcontent',
  'hiddenthought',
  'hiddenthoughts',
  'internalreasoning',
  'rawcot',
  'rawthinking',
  'reasoning',
  'reasoningcontent',
  'scratchpad',
  'think',
  'thinking',
  'thought',
  'thoughts'
]);

const PRIVATE_CREDENTIAL_KEYS = new Set([
  'accesskey',
  'accesskeyid',
  'accesstoken',
  'apikey',
  'apisecret',
  'apitoken',
  'authorization',
  'authorizationheader',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'credential',
  'credentials',
  'cookie',
  'idtoken',
  'jwt',
  'password',
  'passwordhash',
  'passwd',
  'passphrase',
  'privatekey',
  'privatekeypem',
  'refreshtoken',
  'secret',
  'secretaccesskey',
  'secretkey',
  'secretvalue',
  'sessiontoken',
  'setcookie',
  'signature',
  'token',
  'tokenvalue',
  'webhooksecret'
]);

/** Payload-bearing fields are not useful task telemetry and may contain the full prompt or response. */
const TELEMETRY_PAYLOAD_KEYS = new Set([
  'assembledprompt',
  'arguments',
  'body',
  'content',
  'contents',
  'functionarguments',
  'input',
  'messages',
  'output',
  'payload',
  'prompt',
  'rawinput',
  'rawoutput',
  'request',
  'requestbody',
  'response',
  'responsebody',
  'systemprompt',
  'toolarguments',
  'userprompt'
]);

const PRIVATE_TEXT_PATTERNS = [
  /\b(?:bearer|basic)\s+[a-z0-9._~+/=-]{6,}/gi,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret(?:[_-]?key)?)\s*[:=]\s*[^\s,;]+/gi,
  /\b(?:sk|pk|rk)-[a-z0-9_-]{4,}\b/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g
];

const MAX_TELEMETRY_STRING_LENGTH = 4096;

type SanitizationMode = 'general' | 'telemetry';

/** Removes private reasoning and credential fields before data crosses a durable/public boundary. */
export function sanitizePrivateData<T>(value: T): T {
  return sanitize(value, 'general') as T;
}

/** Removes private reasoning, credentials, and prompt/response payloads from telemetry values. */
export function sanitizeTelemetryData<T>(value: T): T {
  return sanitize(value, 'telemetry') as T;
}

export function stripPrivateReasoningText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim();
}

export function redactSensitiveText(text: string): string {
  return PRIVATE_TEXT_PATTERNS.reduce((redacted, pattern) => redacted.replace(pattern, '[REDACTED]'), text);
}

function sanitize(value: unknown, mode: SanitizationMode, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') {
    const redacted = redactSensitiveText(stripPrivateReasoningText(value));
    return mode === 'telemetry' ? truncateTelemetryText(redacted) : redacted;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (seen.has(value)) return '[Circular]';

  seen.add(value);
  if (Array.isArray(value)) {
    try {
      return value.map((item) => sanitize(item, mode, seen));
    } finally {
      seen.delete(value);
    }
  }

  const safe: Record<string, unknown> = {};
  let keys: string[];
  try {
    keys = Object.keys(value);
  } catch {
    seen.delete(value);
    return '[Unserializable]';
  }

  for (const key of keys) {
    const normalizedKey = normalizeKey(key);
    if (normalizedKey === 'tojson') continue;
    if (PRIVATE_REASONING_KEYS.has(normalizedKey) || isPrivateCredentialKey(normalizedKey)) continue;
    if (mode === 'telemetry' && TELEMETRY_PAYLOAD_KEYS.has(normalizedKey)) continue;

    let nestedValue: unknown;
    try {
      nestedValue = (value as Record<string, unknown>)[key];
    } catch {
      continue;
    }
    defineSafeProperty(safe, key, sanitize(nestedValue, mode, seen));
  }
  seen.delete(value);
  return safe;
}

function defineSafeProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true
  });
}

function truncateTelemetryText(text: string): string {
  if (text.length <= MAX_TELEMETRY_STRING_LENGTH) return text;
  return `${text.slice(0, MAX_TELEMETRY_STRING_LENGTH)}[TRUNCATED]`;
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function isPrivateCredentialKey(normalizedKey: string): boolean {
  if (PRIVATE_CREDENTIAL_KEYS.has(normalizedKey)) return true;
  return (
    normalizedKey.startsWith('apikey') ||
    normalizedKey.startsWith('password') ||
    normalizedKey.startsWith('privatekey') ||
    normalizedKey.startsWith('secret') ||
    normalizedKey.endsWith('credential') ||
    normalizedKey.endsWith('tokenvalue')
  );
}
