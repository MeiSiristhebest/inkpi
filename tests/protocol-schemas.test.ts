import {
  AssistantMessageSchema,
  CharacterStateSchema,
  RpcRequestSchema,
  StateLedgerSchema,
  ThinkingLevelSchema,
  Type,
  UsageSchema,
  UserMessageSchema,
  Value,
  assertValid,
  sanitizeNovelStateLedger,
  sanitizeStateLedger,
  validateSchema
} from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('@inkpi/protocol TypeBox Schemas & Validation', () => {
  it('should validate ThinkingLevelSchema', () => {
    expect(Value.Check(ThinkingLevelSchema, 'low')).toBe(true);
    expect(Value.Check(ThinkingLevelSchema, 'high')).toBe(true);
    expect(Value.Check(ThinkingLevelSchema, 'invalid')).toBe(false);
  });

  it('should validate UsageSchema', () => {
    const validUsage = {
      inputTokens: 100,
      outputTokens: 200,
      totalTokens: 300,
      cacheReadTokens: 50
    };
    expect(Value.Check(UsageSchema, validUsage)).toBe(true);

    const invalidUsage = {
      inputTokens: -1,
      outputTokens: 200,
      totalTokens: 300
    };
    expect(Value.Check(UsageSchema, invalidUsage)).toBe(false);
  });

  it('should validate UserMessageSchema and AssistantMessageSchema', () => {
    const userMsg = {
      role: 'user',
      content: '请续写下一章'
    };
    expect(Value.Check(UserMessageSchema, userMsg)).toBe(true);

    const assistantMsg = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '思考剧情发展...' },
        { type: 'text', text: '萧炎深吸了一口气。' },
        { type: 'toolCall', id: 'call_1', name: 'updateStateLedger', arguments: {} }
      ]
    };
    expect(Value.Check(AssistantMessageSchema, assistantMsg)).toBe(true);
  });

  it('should validate CharacterStateSchema and StateLedgerSchema', () => {
    const character = {
      id: 'char_1',
      name: '林动',
      status: 'active',
      inventory: ['神秘石符'],
      faction: '林家'
    };
    expect(Value.Check(CharacterStateSchema, character)).toBe(true);

    const ledger = {
      entities: [character],
      assets: [{ id: 'asset_1', name: '神秘石符', state: 'intact' }],
      tracks: [{ id: 'track_1', summary: '石符之谜', status: 'open' }],
      locations: [{ id: 'loc_1', name: '青阳镇' }]
    };
    expect(Value.Check(StateLedgerSchema, ledger)).toBe(true);
  });

  it('should validate and assert schemas with error details', () => {
    const res = validateSchema(RpcRequestSchema, {
      jsonrpc: '2.0',
      id: 1,
      method: 'agent.prompt',
      params: { prompt: 'hello' }
    });
    expect(res.valid).toBe(true);
    expect(res.errors.length).toBe(0);

    expect(() => {
      assertValid(RpcRequestSchema, { jsonrpc: '1.0', id: 1 }, 'TestRPC');
    }).toThrow(/TestRPC validation failed/);
  });

  it('should sanitize malformed state ledgers gracefully', () => {
    const raw = {
      entities: [{ name: '萧炎', status: 'active', inventory: ['玄重尺'] }, null, { invalid: true }],
      assets: [{ name: '异火' }],
      tracks: [{ summary: '三年之约' }],
      locations: [{ name: '乌坦城' }]
    };

    const sanitized = sanitizeStateLedger(raw);
    expect(sanitized.entities.length).toBe(1);
    expect(sanitized.entities[0].name).toBe('萧炎');
    expect(sanitized.assets.length).toBe(1);
    expect(sanitized.tracks.length).toBe(1);
    expect(sanitized.locations.length).toBe(1);
  });

  it('should keep generic ledger sanitization free of inferred domain semantics', () => {
    const sanitized = sanitizeStateLedger({
      entities: [{ name: 'Entity A' }],
      assets: [{ name: 'Asset A' }],
      tracks: [{ summary: 'A generic work item' }],
      locations: [{ name: 'Place A' }],
      modifiedResources: ['resource-a'],
      customField: { source: 'caller' }
    });

    expect(sanitized.entities[0]).toEqual({ name: 'Entity A' });
    expect(sanitized.assets[0]).toEqual({ name: 'Asset A' });
    expect(sanitized.tracks[0]).toEqual({ summary: 'A generic work item' });
    expect(sanitized.locations[0]).toEqual({ name: 'Place A' });
    expect(sanitized.modifiedResources).toEqual(['resource-a']);
    expect((sanitized as any).customField).toBeUndefined();
  });

  it('should expose novel defaults only through the explicit novel adapter', () => {
    const sanitized = sanitizeNovelStateLedger({
      entities: [{ name: 'Character A' }],
      assets: [{ name: 'Object A' }],
      tracks: [{ summary: 'Unresolved thread' }],
      locations: [{ name: 'Location A' }]
    });

    expect(sanitized.entities[0]).toMatchObject({ id: 'Character A', status: 'active' });
    expect(sanitized.assets[0]).toMatchObject({ id: 'Object A', state: 'normal' });
    expect(sanitized.tracks[0]).toMatchObject({ id: 'track-0', clue: 'Unresolved thread', status: 'open' });
    expect(sanitized.locations[0]).toMatchObject({ id: 'Location A', currentInhabitants: [] });
  });
});
