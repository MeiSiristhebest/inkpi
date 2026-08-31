/**
 * 运行时校验与数据清洗工具 (1:1 对标 pi-protocol validation)
 */

import { Value, type TSchema, type ValidationError } from './typebox.js';
import { StateLedgerSchema, ToolCallContentSchema, RpcRequestSchema } from './schemas.js';
import type { StateLedger } from './storage.js';

export class SchemaValidationError extends Error {
  public errors: ValidationError[];
  constructor(message: string, errors: ValidationError[]) {
    super(`${message}: ${errors.map((e) => `${e.path}: ${e.message}`).join(', ')}`);
    this.name = 'SchemaValidationError';
    this.errors = errors;
  }
}

export function validateSchema<T extends TSchema>(schema: T, value: unknown): { valid: boolean; errors: ValidationError[] } {
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

export function sanitizeStateLedger(raw: any): StateLedger {
  if (!raw || typeof raw !== 'object') {
    return {
      entities: [],
      assets: [],
      tracks: [],
      locations: [],
      modifiedResources: []
    };
  }

  const entities = Array.isArray(raw.entities)
    ? raw.entities.filter(isRecordWithStringName).map((e: Record<string, any>) => {
      const { id, name, type, status, affiliation, relationship, attributes, aliases, location, ...extensions } = e;
      return {
        ...extensions,
        ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
        name,
        ...(typeof type === 'string' ? { type } : {}),
        ...(typeof status === 'string' ? { status } : {}),
        ...(typeof affiliation === 'string' ? { affiliation } : {}),
        ...(typeof relationship === 'string' ? { relationship } : {}),
        ...(isRecord(attributes) ? { attributes } : {}),
        ...(Array.isArray(aliases) ? { aliases: aliases.filter((v: unknown): v is string => typeof v === 'string') } : {}),
        ...(typeof location === 'string' ? { location } : {})
      };
    })
    : [];

  const assets = Array.isArray(raw.assets)
    ? raw.assets.filter(isRecordWithStringName).map((a: Record<string, any>) => {
      const { id, name, holder, owner, type, state, attributes, ...extensions } = a;
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
    })
    : [];

  const tracks = Array.isArray(raw.tracks)
    ? raw.tracks
      .filter((t: any) => isRecord(t) && (typeof t.clue === 'string' || typeof t.summary === 'string' || typeof t.id === 'string'))
      .map((t: Record<string, any>) => {
        const { id, clue, summary, sourceId, status, notes, metadata, ...extensions } = t;
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
      })
    : [];


  const locations = Array.isArray(raw.locations)
    ? raw.locations.filter(isRecordWithStringName).map((l: Record<string, any>) => {
      const { id, name, description, attributes, ...extensions } = l;
      return {
        ...extensions,
        ...(typeof id === 'string' && id.length > 0 ? { id } : {}),
        name,
        ...(typeof description === 'string' ? { description } : {}),
        ...(isRecord(attributes) ? { attributes } : {})
      };
    })
    : [];

  return {
    entities,
    assets,
    tracks,
    locations,
    modifiedResources: Array.isArray(raw.modifiedResources)
      ? raw.modifiedResources.filter((value: unknown): value is string => typeof value === 'string')
      : []
  };
}

/**
 * Explicit compatibility adapter for the former novel-shaped ledger.
 * The generic sanitizer intentionally does not manufacture these meanings.
 */
export function sanitizeNovelStateLedger(raw: any): StateLedger {
  const sanitized = sanitizeStateLedger(raw);
  return {
    ...sanitized,
    entities: sanitized.entities.map((entity: any) => ({
      ...entity,
      id: entity.id || entity.name,
      status: entity.status || 'active'
    })),
    assets: sanitized.assets.map((asset: any) => ({
      ...asset,
      id: asset.id || asset.name,
      state: asset.state || 'normal'
    })),
    tracks: sanitized.tracks.map((track: any, index) => ({
      ...track,
      id: track.id || `track-${index}`,
      clue: track.clue || track.summary || `track-${index}`,
      status: ['open', 'resolved', 'abandoned'].includes(track.status) ? track.status : 'open',
      sourceUnit: track.sourceUnit ?? track.plantedChapter,
      resolvedUnit: track.resolvedUnit ?? track.payoffChapter,
      plantedChapter: track.plantedChapter ?? track.sourceUnit,
      payoffChapter: track.payoffChapter ?? track.resolvedUnit
    })),
    locations: sanitized.locations.map((location: any) => ({
      ...location,
      id: location.id || location.name,
      currentInhabitants: Array.isArray(location.currentInhabitants)
        ? location.currentInhabitants.filter((value: unknown): value is string => typeof value === 'string')
        : []
    }))
  };
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRecordWithStringName(value: unknown): value is Record<string, any> {
  return isRecord(value) && typeof value.name === 'string' && value.name.length > 0;
}
