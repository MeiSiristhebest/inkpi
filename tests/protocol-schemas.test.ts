import { describe, it, expect } from 'vitest';
import {
  Type,
  Value,
  validateSchema,
  assertValid,
  sanitizeStateLedger,
  ThinkingLevelSchema,
  UsageSchema,
  UserMessageSchema,
  AssistantMessageSchema,
  CharacterStateSchema,
  StateLedgerSchema,
  RpcRequestSchema
} from '@inkpi/protocol';

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
      entities: [
        { name: '萧炎', status: 'active', inventory: ['玄重尺'] },
        null,
        { invalid: true }
      ],
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
});
