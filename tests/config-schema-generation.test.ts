import { readFileSync } from 'node:fs';
import { type TSchema, Value } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG_ENTRY_SCHEMA, MODEL_CATALOG_SCHEMA } from '../packages/ai/src/catalog-schema.js';

describe('model catalog schema', () => {
  const catalog = JSON.parse(
    readFileSync(new URL('../packages/ai/src/models-data.json', import.meta.url), 'utf8')
  ) as unknown[];

  it('validates the existing offline catalog and allows extension properties', () => {
    const firstEntry = catalog[0];
    if (!isRecord(firstEntry)) throw new Error('Expected the model catalog to contain object entries');

    // SAFETY: Value.Check accepts standard JSON Schema at runtime; TSchema adds a TypeBox builder marker only.
    const schema = MODEL_CATALOG_SCHEMA as unknown as TSchema;
    // SAFETY: Value.Check accepts standard JSON Schema at runtime; TSchema adds a TypeBox builder marker only.
    const entrySchema = MODEL_CATALOG_ENTRY_SCHEMA as unknown as TSchema;
    expect(Value.Check(schema, catalog)).toBe(true);
    expect(Value.Check(entrySchema, { ...firstEntry, vendorMetadata: { region: 'local' } })).toBe(true);
    expect(Value.Check(entrySchema, { ...firstEntry, id: '' })).toBe(false);
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
