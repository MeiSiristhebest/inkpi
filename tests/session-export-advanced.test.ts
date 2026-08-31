import { describe, it, expect } from 'vitest';
import { SessionExporter, SessionTree } from '@inkpi/agent-core';
import type { AgentMessage, UserMessage, AssistantMessage } from '@inkpi/protocol';

describe('@inkpi/agent-core -> Advanced SessionExporter (HTML & JSONL)', () => {
  it('should export and import session to/from JSONL losslessly', () => {
    const exporter = new SessionExporter();

    const originalMessages: AgentMessage[] = [
      { id: 'msg_1', role: 'user', content: '第一document大纲' } as UserMessage,
      {
        id: 'msg_2',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '思考伏笔规划' },
          { type: 'text', text: '大纲已生成' }
        ],
        stopReason: 'stop'
      } as AssistantMessage
    ];

    const jsonl = exporter.exportToJsonl(originalMessages);
    expect(jsonl).toContain('msg_1');
    expect(jsonl).toContain('msg_2');

    const imported = exporter.importFromJsonl(jsonl);
    expect(imported.length).toBe(2);
    expect(imported[0].role).toBe('user');
    expect(imported[1].role).toBe('assistant');
    if (imported[1].role === 'assistant') {
      expect(imported[1].content.length).toBe(2);
    }
  });

  it('should reject malformed or schema-invalid JSONL instead of dropping messages', () => {
    const exporter = new SessionExporter();
    const invalid = '{"role":"assistant","content":"not-an-array"}';

    expect(() => exporter.importFromJsonl(invalid)).toThrow(/line 1/);
    expect(exporter.importFromJsonl(`${invalid}\n${JSON.stringify({ role: 'user', content: 'ok' })}`, { strict: false }))
      .toHaveLength(1);
  });

  it('should render rich interactive HTML report with thinking blocks and branch information', () => {
    const exporter = new SessionExporter();
    const tree = new SessionTree();

    const m1 = { id: 'm1', role: 'user', content: '初始构思' } as UserMessage;
    const m2 = {
      id: 'm2',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '深度构思' },
        { type: 'text', text: '正文回复' }
      ]
    } as AssistantMessage;

    tree.addMessage(m1);
    tree.addMessage(m2);

    const html = exporter.exportToHtml([m1, m2], { format: 'html', title: '全书创作档案' }, tree);

    expect(html).toContain('全书创作档案');
    expect(html).toContain('Thinking');
    expect(html).toContain('Assistant');
    expect(html).toContain('Branches: 1');
  });
});
