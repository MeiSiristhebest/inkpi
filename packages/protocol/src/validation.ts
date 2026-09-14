/**
 * 运行时校验与数据清洗工具
 */

import type { RuntimeState } from './pipeline.js';
import { RpcRequestSchema, StateLedgerSchema, ToolCallContentSchema } from './schemas.js';
import type { LegacyStateLedger, StateLedger } from './storage.js';
import { type TSchema, type ValidationError, Value } from './typebox.js';

export class SchemaValidationError extends Error {
  public errors: ValidationError[];
  constructor(message: string, errors: ValidationError[]) {
    super(`${message}: ${errors.map((e) => `${e.path}: ${e.message}`).join(', ')}`);
    this.name = 'SchemaValidationError';
    this.errors = errors;
  }
}

export function validateSchema<T extends TSchema>(
  schema: T,
  value: unknown
): { valid: boolean; errors: ValidationError[] } {
  const errors = Value.Errors(schema, value);
  return {
    valid: errors.length === 0,
    errors
  };
}

export function assertValid<T extends TSchema>(schema: T, value: unknown, contextName = 'Payload'): void {
  const { valid, errors } = validateSchema(schema, value);
  if (!valid) {
    throw new SchemaValidationError(`${contextName} validation failed`, errors);
  }
}

/**
 * Copy an opaque Runtime state without interpreting product-domain keys.
 * Invalid top-level values normalize to an empty object; nested values remain
 * caller-owned and untouched.
 */
export function sanitizeRuntimeState(raw: unknown): RuntimeState {
  return isRecord(raw) ? { ...raw } : {};
}

/**
 * Normalize the historical structured ledger shape at an explicit adapter
 * boundary. Generic Runtime code must call `sanitizeRuntimeState` instead.
 */
export function sanitizeLegacyStateLedger(raw: unknown): LegacyStateLedger {
  const source = isRecord(raw) ? raw : {};

  return {
    entities: sanitizeEntities(readLegacyArray(source, 'entities', 'characters')),
    assets: sanitizeAssets(readLegacyArray(source, 'assets', 'items')),
    tracks: sanitizeTracks(readLegacyArray(source, 'tracks', 'foreshadowings')),
    locations: sanitizeLocations(readLegacyArray(source, 'locations')),
    modifiedResources: readStringList(source, ['modifiedResources', 'modifiedChapters', 'modifiedDocuments']),
    ...(source.customExtension !== undefined ? { customExtension: source.customExtension } : {})
  };
}

/** @deprecated Legacy adapter. Use `sanitizeRuntimeState` for generic Runtime payloads. */
export function sanitizeStateLedger(raw: unknown): StateLedger {
  return sanitizeLegacyStateLedger(raw);
}

/**
 * Explicit compatibility adapter for the older document-shaped ledger. Only
 * this adapter supplies product-specific defaults and derived fields.
 */
export function sanitizeNovelStateLedger(raw: unknown): StateLedger {
  const sanitized = sanitizeLegacyStateLedger(raw);
  return {
    ...sanitized,
    entities: sanitized.entities.map((entity) => ({
      ...entity,
      id: typeof entity.id === 'string' && entity.id.length > 0 ? entity.id : entity.name,
      status: typeof entity.status === 'string' && entity.status.length > 0 ? entity.status : 'active'
    })),
    assets: sanitized.assets.map((asset) => ({
      ...asset,
      id: typeof asset.id === 'string' && asset.id.length > 0 ? asset.id : asset.name,
      state: typeof asset.state === 'string' && asset.state.length > 0 ? asset.state : 'normal'
    })),
    tracks: sanitized.tracks.map((track, index) => {
      const status = typeof track.status === 'string' ? track.status : undefined;
      const sourceUnit = track.sourceUnit ?? track.plantedChapter;
      const resolvedUnit = track.resolvedUnit ?? track.payoffChapter;
      return {
        ...track,
        id: typeof track.id === 'string' && track.id.length > 0 ? track.id : `track-${index}`,
        clue:
          typeof track.clue === 'string' && track.clue.length > 0
            ? track.clue
            : typeof track.summary === 'string' && track.summary.length > 0
              ? track.summary
              : `track-${index}`,
        status: status && ['open', 'resolved', 'abandoned'].includes(status) ? status : 'open',
        sourceUnit,
        resolvedUnit,
        plantedChapter: sourceUnit,
        payoffChapter: resolvedUnit
      };
    }),
    locations: sanitized.locations.map((location) => ({
      ...location,
      id: typeof location.id === 'string' && location.id.length > 0 ? location.id : location.name,
      currentInhabitants: Array.isArray(location.currentInhabitants)
        ? location.currentInhabitants.filter((value): value is string => typeof value === 'string')
        : []
    }))
  };
}

function sanitizeEntities(values: unknown[]): LegacyStateLedger['entities'] {
  return values.filter(isRecordWithStringName).map((entity) => {
    const { id, name, type, status, affiliation, relationship, attributes, aliases, location, ...extensions } = entity;
    return {
      ...extensions,
      ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
      name,
      ...(typeof type === 'string' ? { type } : {}),
      ...(typeof status === 'string' ? { status } : {}),
      ...(typeof affiliation === 'string' ? { affiliation } : {}),
      ...(typeof relationship === 'string' ? { relationship } : {}),
      ...(isRecord(attributes) ? { attributes } : {}),
      ...(Array.isArray(aliases)
        ? { aliases: aliases.filter((value): value is string => typeof value === 'string') }
        : {}),
      ...(typeof location === 'string' ? { location } : {})
    };
  });
}

function sanitizeAssets(values: unknown[]): LegacyStateLedger['assets'] {
  return values.filter(isRecordWithStringName).map((asset) => {
    const { id, name, holder, owner, type, state, attributes, ...extensions } = asset;
    return {
      ...extensions,
      ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
      name,
      ...(typeof holder === 'string' ? { holder } : {}),
      ...(typeof owner === 'string' ? { owner } : {}),
      ...(typeof type === 'string' ? { type } : {}),
      ...(typeof state === 'string' ? { state } : {}),
      ...(isRecord(attributes) ? { attributes } : {})
    };
  });
}

function sanitizeTracks(values: unknown[]): LegacyStateLedger['tracks'] {
  return values.filter(isTrackCandidate).map((track) => {
    const { id, clue, summary, sourceId, status, notes, metadata, ...extensions } = track;
    return {
      ...extensions,
      ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
      ...(typeof clue === 'string' ? { clue } : {}),
      ...(typeof summary === 'string' ? { summary } : {}),
      ...(typeof sourceId === 'string' ? { sourceId } : {}),
      ...(typeof status === 'string' ? { status } : {}),
      ...(typeof notes === 'string' ? { notes } : {}),
      ...(isRecord(metadata) ? { metadata } : {})
    };
  });
}

function sanitizeLocations(values: unknown[]): LegacyStateLedger['locations'] {
  return values.filter(isRecordWithStringName).map((location) => {
    const { id, name, description, attributes, ...extensions } = location;
    return {
      ...extensions,
      ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
      name,
      ...(typeof description === 'string' ? { description } : {}),
      ...(isRecord(attributes) ? { attributes } : {})
    };
  });
}

function readLegacyArray(source: Record<string, unknown>, canonicalKey: string, aliasKey?: string): unknown[] {
  const canonical = source[canonicalKey];
  if (Array.isArray(canonical)) return canonical;
  const alias = aliasKey ? source[aliasKey] : undefined;
  return Array.isArray(alias) ? alias : [];
}

function readStringList(source: Record<string, unknown>, keys: string[]): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const candidate = source[key];
    if (!Array.isArray(candidate)) continue;
    for (const value of candidate) {
      if (typeof value === 'string' && !seen.has(value)) {
        seen.add(value);
        values.push(value);
      }
    }
  }
  return values;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

type NamedRecord = Record<string, unknown> & { name: string };

function isRecordWithStringName(value: unknown): value is NamedRecord {
  return isRecord(value) && typeof value.name === 'string' && value.name.length > 0;
}

function isTrackCandidate(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    (typeof value.clue === 'string' || typeof value.summary === 'string' || typeof value.id === 'string')
  );
}
