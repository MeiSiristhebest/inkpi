import { describe, it, expect } from 'vitest';
import {
  extractNovelStateLedger,
  extractStateLedger,
  formatStateLedger,
  NarrativeSemanticLedgerExtractor,
  SessionCompactor
} from '@inkpi/agent-core';
import type { AgentMessage, UserMessage, AssistantMessage } from '@inkpi/protocol';

describe('@inkpi/agent-core -> State Ledger Context Compaction', () => {
  it('should accurately extract state ledger from structured tags, tool calls, and text', () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: '<entity name="Alice" status="Lead" /> <asset name="QuantumKey" holder="Alice" />'
      } as UserMessage,
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '<track clue="CoreDatabase" status="pending" />' },
          { type: 'text', text: 'Alice secures the QuantumKey and issues system alert.' }
        ]
      } as AssistantMessage,
      {
        role: 'user',
        content: '<entity name="Bob" status="Observer" /> doc_12'
      } as UserMessage
    ];

    // Custom extractor extension capability
    const customExtractor = {
      name: 'custom_keyword_extractor',
      extract(rawText: string, ctx: any) {
        if (rawText.includes('CustomSignal')) {
          ctx.tracksMap.set('CustomSignalCaptured', {
            clue: 'CustomSignalCaptured',
            status: 'resolved'
          });
        }
      }
    };

    const genericLedger = extractStateLedger(messages);
    expect(genericLedger.entities).toEqual([]);
    expect(genericLedger.assets).toEqual([]);
    expect(genericLedger.tracks).toEqual([]);

    const ledger = extractNovelStateLedger([...messages, { role: 'user', content: 'Received CustomSignal' } as any], [customExtractor]);

    expect(ledger.entities.some((c) => c.name === 'Alice')).toBe(true);
    expect(ledger.entities.some((c) => c.name === 'Bob')).toBe(true);
    expect(ledger.assets.some((i) => i.name.includes('QuantumKey'))).toBe(true);
    expect(ledger.tracks.some((f) => f.clue?.includes('CoreDatabase'))).toBe(true);
    expect(ledger.tracks.some((f) => f.clue === 'CustomSignalCaptured')).toBe(true);
    expect(ledger.modifiedResources?.some((ch) => ch.includes('doc_12'))).toBe(true);

    const formatted = formatStateLedger(ledger);
    expect(formatted).toContain('Entities:');
    expect(formatted).toContain('Assets:');
    expect(formatted).toContain('Tracks:');

    // Test custom formatter
    const customFormatted = formatStateLedger(ledger, (l) => `CUSTOM:[${l.entities.length}]`);
    expect(customFormatted).toBe(`CUSTOM:[${ledger.entities.length}]`);

    // Test empty/falsy ledger
    expect(formatStateLedger(undefined)).toBe('');

    // Tool call extraction for modify_resource, update_character, update_asset
    const toolCallMsgs: AgentMessage[] = [
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call_res',
            name: 'modify_resource',
            arguments: { title: 'doc_custom_section' }
          },
          {
            type: 'toolCall',
            id: 'call_char',
            name: 'update_character',
            arguments: { name: 'CharacterBeta', status: 'StandingBy', affiliation: 'SquadX', relationship: 'Ally' }
          },
          {
            type: 'toolCall',
            id: 'call_item',
            name: 'update_item',
            arguments: { name: 'ToolItemA', holder: 'CharacterBeta', state: 'Ready' }
          },
          {
            type: 'toolCall',
            id: 'call_track',
            name: 'track_foreshadowing',
            arguments: { content: 'SecretVaultClue', status: 'pending' }
          }
        ]
      } as any
    ];
    const toolCallLedger = extractNovelStateLedger(toolCallMsgs);
    expect(toolCallLedger.modifiedResources).toContain('doc_custom_section');
    expect(toolCallLedger.entities.some((e) => e.name === 'CharacterBeta')).toBe(true);
    expect(toolCallLedger.assets.some((a) => a.name === 'ToolItemA')).toBe(true);
    expect(toolCallLedger.tracks.some((t) => t.clue === 'SecretVaultClue')).toBe(true);
  });

  it('should embed structured state ledger into CompactionEntry details and prompt during compact', async () => {
    const compactor = new SessionCompactor({
      triggerTokensThreshold: 30,
      preserveRecentCount: 1,
      summarizer: async () => 'Core Summary: Key acquired and initialization completed.',
      ledgerExtractors: [NarrativeSemanticLedgerExtractor],
      ledgerFormatter: (ledger) => `entities=${ledger.entities.map((entity) => entity.name).join(',')}`
    });

    const messages: AgentMessage[] = [
      { role: 'user', content: 'doc_1 <entity name="Alice" /> <asset name="HyperTerminal" /> <track clue="SystemInit" status="pending" />' } as UserMessage,
      { role: 'assistant', content: [{ type: 'text', text: 'Alice successfully activated HyperTerminal.' }] } as AssistantMessage,
      { role: 'user', content: 'doc_2 Proceed to command center.' } as UserMessage,
      { role: 'assistant', content: [{ type: 'text', text: 'Alice enters the command center.' }] } as AssistantMessage
    ];

    expect(compactor.shouldCompact(messages)).toBe(true);

    const result = await compactor.compact(messages);

    expect(result.entry.details).toBeDefined();
    const ledger = (result.entry.details as any).stateLedger;
    expect(ledger).toBeDefined();
    expect(ledger.entities.some((c: any) => c.name === 'Alice')).toBe(true);
    expect(result.compactedMessages[0].role).toBe('assistant');
    if (result.compactedMessages[0].role === 'assistant') {
      const text = (result.compactedMessages[0].content[0] as any).text;
      expect(text).toContain('Context Summary');
      expect(text).toContain('State Ledger');
    }
  });
});
