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

/** Removes private reasoning fields before data crosses a durable/public boundary. */
export function sanitizePrivateData<T>(value: T): T {
  return sanitize(value) as T;
}

export function stripPrivateReasoningText(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/gi, '')
    .trim();
}

function sanitize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitize);
  if (typeof value === 'string') return stripPrivateReasoningText(value);
  if (value === null || typeof value !== 'object') return value;

  const safe: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (PRIVATE_REASONING_KEYS.has(normalizeKey(key))) continue;
    safe[key] = sanitize(nestedValue);
  }
  return safe;
}

function normalizeKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}
