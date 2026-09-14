import { SessionCompactor, extractRuntimeState, formatRuntimeState } from '@inkpi/agent-core';
import type { RuntimeStateExtractor } from '@inkpi/agent-core';
import type { AgentMessage, RuntimeState, UserMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { creativeStateExtractor, readCreativeRuntimeState } from './fixtures/domain-adapters.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRuntimeState(details: unknown): RuntimeState | undefined {
  if (!isRecord(details) || !isRecord(details.runtimeState)) return undefined;
  return details.runtimeState;
}

describe('@inkpi/agent-core -> Generic Runtime State Context Compaction', () => {
  it('should extract state only through explicitly injected adapters', () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: '<entity name="Alice" status="Lead" /> <asset name="QuantumKey" holder="Alice" />'
      },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '<track clue="CoreDatabase" status="pending" />' },
          { type: 'text', text: 'Alice secures the QuantumKey and issues system alert.' }
        ]
      },
      {
        role: 'user',
        content: '<entity name="Bob" status="Observer" /> doc_12'
      }
    ];

    // Custom extractor extension capability
    const customExtractor: RuntimeStateExtractor = {
      id: 'custom_keyword_extractor',
      extract(rawText: string, ctx) {
        if (rawText.includes('CustomSignal')) {
          const tracks = readCreativeRuntimeState(ctx.state).tracks;
          ctx.state.tracks = [
            ...tracks,
            {
              clue: 'CustomSignalCaptured',
              status: 'resolved'
            }
          ];
        }
      }
    };

    const genericState = extractRuntimeState(messages);
    expect(genericState).toEqual({});

    const state = extractRuntimeState(
      [...messages, { role: 'user', content: 'Received CustomSignal' } satisfies UserMessage],
      [creativeStateExtractor, customExtractor]
    );
    const creativeState = readCreativeRuntimeState(state);

    expect(creativeState.entities.some((entity) => entity.name === 'Alice')).toBe(true);
    expect(creativeState.entities.some((entity) => entity.name === 'Bob')).toBe(true);
    expect(
      creativeState.assets.some((asset) => typeof asset.name === 'string' && asset.name.includes('QuantumKey'))
    ).toBe(true);
    expect(
      creativeState.tracks.some((track) => typeof track.clue === 'string' && track.clue.includes('CoreDatabase'))
    ).toBe(true);
    expect(creativeState.tracks.some((track) => track.clue === 'CustomSignalCaptured')).toBe(true);
    expect(creativeState.modifiedResources.some((resource) => resource.includes('doc_12'))).toBe(true);

    const formatted = formatRuntimeState(state);
    expect(formatted).toContain('entities');
    expect(formatted).toContain('assets');
    expect(formatted).toContain('tracks');

    // Test custom formatter
    const customFormatted = formatRuntimeState(state, (runtimeState) => {
      const creativeState = readCreativeRuntimeState(runtimeState);
      return `CUSTOM:[${creativeState.entities.length}]`;
    });
    expect(customFormatted).toBe(`CUSTOM:[${creativeState.entities.length}]`);

    // Test empty/falsy state
    expect(formatRuntimeState(undefined)).toBe('');

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
      }
    ];
    const toolCallState = extractRuntimeState(toolCallMsgs, [creativeStateExtractor]);
    const toolState = readCreativeRuntimeState(toolCallState);
    expect(toolState.modifiedResources).toContain('doc_custom_section');
    expect(toolState.entities.some((entity) => entity.name === 'CharacterBeta')).toBe(true);
    expect(toolState.assets.some((asset) => asset.name === 'ToolItemA')).toBe(true);
    expect(toolState.tracks.some((track) => track.clue === 'SecretVaultClue')).toBe(true);
  });

  it('should embed injected runtime state into CompactionEntry details and prompt during compact', async () => {
    const compactor = new SessionCompactor({
      clock: Date.now,
      triggerTokensThreshold: 30,
      preserveRecentCount: 1,
      summarizer: async () => 'Core Summary: Key acquired and initialization completed.',
      stateExtractors: [creativeStateExtractor],
      stateFormatter: (state) =>
        `entities=${readCreativeRuntimeState(state)
          .entities.map((entity) => String(entity.name ?? ''))
          .join(',')}`
    });

    const messages: AgentMessage[] = [
      {
        role: 'user',
        content:
          'doc_1 <entity name="Alice" /> <asset name="HyperTerminal" /> <track clue="SystemInit" status="pending" />'
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Alice successfully activated HyperTerminal.' }]
      },
      { role: 'user', content: 'doc_2 Proceed to command center.' },
      { role: 'assistant', content: [{ type: 'text', text: 'Alice enters the command center.' }] }
    ];

    expect(compactor.shouldCompact(messages)).toBe(true);

    const result = await compactor.compact(messages);

    expect(result.entry.details).toBeDefined();
    const state = readCreativeRuntimeState(readRuntimeState(result.entry.details));
    expect(state.entities.some((entity) => entity.name === 'Alice')).toBe(true);
    const summaryMessage = result.compactedMessages[0];
    expect(summaryMessage?.role).toBe('assistant');
    if (summaryMessage?.role === 'assistant') {
      const firstBlock = summaryMessage.content[0];
      expect(firstBlock?.type).toBe('text');
      if (firstBlock?.type !== 'text') return;
      const text = firstBlock.text;
      expect(text).toContain('Context Summary');
      expect(text).toContain('Runtime State');
    }
  });
});
