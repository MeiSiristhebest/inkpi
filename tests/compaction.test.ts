import { SessionCompactor } from '@inkpi/agent-core';
import type { AgentMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core -> Context Compaction Engine (1:1 Ported from repos/pi)', () => {
  it('should estimate tokens, detect context overflow, and perform recursive summarization', async () => {
    const compactor = new SessionCompactor({
      triggerTokensThreshold: 50, // Small threshold for testing
      preserveRecentCount: 2,
      summarizer: async (conv) => {
        return `【剧情收束与状态】主角完成了筑基突破，击退了黑煞教护法。当前已埋下古玉Task。详细对话：${conv.slice(0, 50)}`;
      }
    });

    const messages: AgentMessage[] = [
      { id: 'm1', role: 'user', content: '第一幕：主角在山洞中闭关修炼九转玄功。' },
      {
        id: 'm2',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '构思突破雷劫因果' },
          { type: 'text', text: '洞府内灵气翻涌，紫霄神雷滚滚落下。' }
        ]
      },
      { id: 'm3', role: 'user', content: '第二幕：黑煞教突袭洞府，主角持剑迎敌。' },
      {
        id: 'm4',
        role: 'assistant',
        content: [{ type: 'text', text: '主角一剑霜寒十四州，将黑煞护法斩于马下。' }]
      },
      { id: 'm5', role: 'user', content: '第三幕：发现黑煞教护法身上掉落一块染血古玉。' }
    ];

    expect(compactor.estimateTokens(messages)).toBeGreaterThan(50);
    expect(compactor.shouldCompact(messages)).toBe(true);

    const { compactedMessages, entry } = await compactor.compact(messages);

    expect(entry.type).toBe('compaction');
    expect(entry.tokensBefore).toBeGreaterThan(50);
    expect(entry.summary).toContain('主角完成了筑基突破');

    // Recent 2 messages (m4 and m5) preserved + 1 summary message
    expect(compactedMessages.length).toBe(3);
    expect(compactedMessages[0].role).toBe('assistant');
    expect(compactedMessages[1].id).toBe('m4');
    expect(compactedMessages[2].id).toBe('m5');
  });
});
