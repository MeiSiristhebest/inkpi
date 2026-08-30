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
    ? raw.entities.filter((e: any) => e && typeof e.name === 'string').map((e: any) => ({
        id: String(e.id || e.name),
        name: String(e.name),
        status: String(e.status || 'active'),
        aliases: Array.isArray(e.aliases) ? e.aliases.map(String) : [],
        faction: e.faction ? String(e.faction) : undefined,
        inventory: Array.isArray(e.inventory) ? e.inventory.map(String) : [],
        location: e.location ? String(e.location) : undefined,
        relationships: typeof e.relationships === 'object' && e.relationships ? e.relationships : {},
        lastSeenChapter: typeof e.lastSeenChapter === 'number' ? e.lastSeenChapter : undefined
      }))
    : [];

  const assets = Array.isArray(raw.assets)
    ? raw.assets.filter((a: any) => a && typeof a.name === 'string').map((a: any) => ({
        id: String(a.id || a.name),
        name: String(a.name),
        state: String(a.state || 'normal'),
        owner: a.owner ? String(a.owner) : undefined,
        significance: a.significance ? String(a.significance) : undefined
      }))
    : [];

  const tracks = Array.isArray(raw.tracks)
    ? raw.tracks.filter((t: any) => t && (t.summary || t.id)).map((t: any) => ({
        id: String(t.id || `track-${Date.now()}`),
        summary: String(t.summary || t.title || '未命名伏笔'),
        status: ['open', 'resolved', 'abandoned'].includes(t.status) ? t.status : 'open',
        plantedChapter: typeof t.plantedChapter === 'number' ? t.plantedChapter : undefined,
        payoffChapter: typeof t.payoffChapter === 'number' ? t.payoffChapter : undefined
      }))
    : [];

  const locations = Array.isArray(raw.locations)
    ? raw.locations.filter((l: any) => l && typeof l.name === 'string').map((l: any) => ({
        id: String(l.id || l.name),
        name: String(l.name),
        description: l.description ? String(l.description) : undefined,
        currentInhabitants: Array.isArray(l.currentInhabitants) ? l.currentInhabitants.map(String) : []
      }))
    : [];

  return {
    entities,
    assets,
    tracks,
    locations,
    modifiedResources: Array.isArray(raw.modifiedResources) ? raw.modifiedResources.map(String) : []
  };
}
