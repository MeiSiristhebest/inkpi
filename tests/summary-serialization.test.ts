import type { AgentMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { serializeConversationForSummary } from '../packages/agent-core/src/compaction/summarize.js';

function isWellFormedUtf16(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

describe('summary conversation serialization', () => {
  it('keeps visible intent, assistant text, tool calls/results and references while excluding thinking and image bytes', () => {
    const messages: AgentMessage[] = [
      { id: 'u1', role: 'user', content: 'Find the existing chapter artifact and preserve the user constraint.' },
      {
        id: 'a1',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'PRIVATE_REASONING_SENTINEL' },
          { type: 'text', text: 'I will inspect the chapter record.' },
          { type: 'toolCall', id: 'call-1', name: 'search_chapters', arguments: { query: 'chapter 7' } }
        ]
      },
      {
        id: 't1',
        role: 'toolResult',
        toolCallId: 'call-1',
        toolName: 'search_chapters',
        content: [{ type: 'text', text: 'Found the matching chapter.' }],
        details: { artifactRef: 'artifact://workspace/chapter-7' }
      },
      {
        id: 'u2',
        role: 'user',
        content: [
          { type: 'text', text: 'Use the source image too.' },
          { type: 'image', image: 'PRIVATE_IMAGE_BYTES', mimeType: 'image/png' }
        ]
      }
    ];
    const original = structuredClone(messages);

    const serialized = serializeConversationForSummary(messages);

    expect(serialized).toContain('preserve the user constraint');
    expect(serialized).toContain('I will inspect the chapter record.');
    expect(serialized).toContain('search_chapters');
    expect(serialized).toContain('"query":"chapter 7"');
    expect(serialized).toContain('Found the matching chapter.');
    expect(serialized).toContain('artifact://workspace/chapter-7');
    expect(serialized).toContain('mimeType=image/png');
    expect(serialized).not.toContain('PRIVATE_REASONING_SENTINEL');
    expect(serialized).not.toContain('PRIVATE_IMAGE_BYTES');
    expect(messages).toEqual(original);
  });

  it('handles empty histories and thinking-only assistant messages without leaking reasoning', () => {
    expect(serializeConversationForSummary([])).toBe('');
    expect(
      serializeConversationForSummary([
        { role: 'user', content: '' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_EMPTY_CASE' }] }
      ])
    ).not.toContain('PRIVATE_EMPTY_CASE');
  });

  it('caps each tool result with an explicit marker while retaining existing tail references', () => {
    const text = `${'large result facts '.repeat(80)} existing-ref=artifact://workspace/important-result`;
    const serialized = serializeConversationForSummary(
      [
        {
          role: 'toolResult',
          toolCallId: 'lookup-1',
          toolName: 'lookup',
          content: [{ type: 'text', text }]
        }
      ],
      { maxInputTokens: 1_000, maxToolResultTokens: 260, charsPerToken: 1 }
    );

    expect(serialized.length).toBeLessThanOrEqual(260);
    expect(serialized).toContain('TOOL RESULT lookup: original=');
    expect(serialized).toContain('existing-ref=artifact://workspace/important-result');
    expect(serialized).not.toContain('large result facts '.repeat(80));
  });

  it('caps the complete transcript and truncates only at safe Unicode boundaries', () => {
    const unicode = '用户约束🧑🏽‍💻 e\u0301 '.repeat(150);
    const serialized = serializeConversationForSummary(
      [
        { role: 'user', content: unicode },
        { role: 'assistant', content: [{ type: 'text', text: `${unicode}最末尾的最新结论` }] }
      ],
      { maxInputTokens: 160, charsPerToken: 1 }
    );

    expect(serialized.length).toBeLessThanOrEqual(160);
    expect(serialized).toContain('SUMMARY INPUT: original=');
    expect(serialized).toContain('最末尾的最新结论');
    expect(isWellFormedUtf16(serialized)).toBe(true);
    expect(serialized).not.toMatch(/[\uD800-\uDBFF]…/u);
    expect(serialized).not.toMatch(/…[\uDC00-\uDFFF]/u);
    expect(serialized).not.toMatch(/…\u200d|\u200d…/u);
    expect(serialized).not.toMatch(/…\p{Mark}|\p{Mark}…/u);
  });
});
