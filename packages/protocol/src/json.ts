/**
 * JSON-safe values used at Runtime, RPC, tool, and persistence boundaries.
 *
 * Internal Runtime objects may remain richer than this type.  Values crossing
 * a serializable boundary must not rely on JSON.stringify coercions such as
 * dropping `undefined`, converting holes to `null`, or invoking `toJSON`.
 */

export type JsonPrimitive = string | number | boolean | null;

export interface JsonObject {
  [key: string]: JsonValue;
}

export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

export interface JsonValueError {
  path: string;
  message: string;
  value: unknown;
}

const JSON_OBJECT_PROTOTYPES = new Set<object | null>([Object.prototype, null]);

/** Return the first reason a value cannot cross a strict JSON boundary. */
export function findJsonValueError(value: unknown, path = '$'): JsonValueError | undefined {
  return findJsonValueErrorInternal(value, path, new Set<object>());
}

/** Return the first reason a value is not a strict JSON object. */
export function findJsonObjectError(value: unknown, path = '$'): JsonValueError | undefined {
  if (!isPlainObject(value)) {
    return {
      path,
      message: `Expected a JSON object, got ${describeValue(value)}`,
      value
    };
  }
  return findJsonValueError(value, path);
}

export function isJsonValue(value: unknown): value is JsonValue {
  return findJsonValueError(value) === undefined;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return findJsonObjectError(value) === undefined;
}

export function assertJsonValue(value: unknown, context = 'Value'): asserts value is JsonValue {
  const issue = findJsonValueError(value, '$');
  if (issue) throw new JsonValueValidationError(`${context} is not JSON-safe`, issue);
}

export function assertJsonObject(value: unknown, context = 'Value'): asserts value is JsonObject {
  const issue = findJsonObjectError(value, '$');
  if (issue) throw new JsonValueValidationError(`${context} is not a JSON object`, issue);
}

export class JsonValueValidationError extends Error {
  public readonly issue: JsonValueError;

  constructor(message: string, issue: JsonValueError) {
    super(`${message}: ${issue.path} ${issue.message}`);
    this.name = 'JsonValueValidationError';
    this.issue = issue;
  }
}

function findJsonValueErrorInternal(value: unknown, path: string, ancestors: Set<object>): JsonValueError | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return undefined;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? undefined : { path, message: 'Expected a finite JSON number', value };
  }

  if (value === undefined) {
    return { path, message: 'Undefined is not a JSON value', value };
  }

  if (typeof value !== 'object') {
    return { path, message: `Unsupported JSON value type '${typeof value}'`, value };
  }

  if (ancestors.has(value)) {
    return { path, message: 'Cyclic references are not valid JSON', value };
  }

  if (!Array.isArray(value) && !isPlainObject(value)) {
    return { path, message: 'Expected a plain JSON object or array', value };
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) {
          return { path: `${path}[${index}]`, message: 'Sparse arrays are not valid JSON', value: undefined };
        }
        const issue = findJsonValueErrorInternal(value[index], `${path}[${index}]`, ancestors);
        if (issue) return issue;
      }

      for (const key of Object.keys(value)) {
        if (!isArrayIndexKey(key, value.length)) {
          return {
            path: `${path}.${key}`,
            message: 'Array properties must be numeric indices',
            value: value[Number(key)]
          };
        }
      }
      return undefined;
    }

    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { path, message: 'Symbol-keyed properties are not valid JSON', value };
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      const issue = findJsonValueErrorInternal(nestedValue, `${path}.${key}`, ancestors);
      if (issue) return issue;
    }
    return undefined;
  } finally {
    ancestors.delete(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> | unknown[] {
  if (typeof value !== 'object' || value === null) return false;
  return JSON_OBJECT_PROTOTYPES.has(Object.getPrototypeOf(value));
}

function isArrayIndexKey(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
