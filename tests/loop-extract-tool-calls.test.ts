import { describe, it, expect } from 'vitest';
import { extractToolCalls } from '../packages/agent-core/src/loop.js';
import type { AssistantMessage } from '@inkpi/protocol';

function msg(content: AssistantMessage['content']): AssistantMessage {
  return { role: 'assistant', content };
}

describe('extractToolCalls (pure)', () => {
  it('提取所有 toolCall 块，忽略 text/thinking/image', () => {
    const m = msg([
      { type: 'text', text: 'hi' },
      { type: 'toolCall', id: 't1', name: 'search', arguments: {} },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'toolCall', id: 't2', name: 'write', arguments: {} }
    ]);
    const calls = extractToolCalls(m);
    expect(calls.map((c) => c.id)).toEqual(['t1', 't2']);
    expect(calls.every((c) => c.type === 'toolCall')).toBe(true);
  });

  it('无 toolCall 时返回空数组', () => {
    const m = msg([{ type: 'text', text: 'no tools' }]);
    expect(extractToolCalls(m)).toEqual([]);
  });

  it('空 content 返回空数组', () => {
    expect(extractToolCalls(msg([]))).toEqual([]);
  });

  it('保留完整 ToolCallContent（含 name/arguments）', () => {
    const m = msg([{ type: 'toolCall', id: 'x', name: 'run', arguments: { a: 1 } }]);
    const calls = extractToolCalls(m);
    expect(calls[0]).toEqual({ type: 'toolCall', id: 'x', name: 'run', arguments: { a: 1 } });
  });
});
