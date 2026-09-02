import { SessionExporter, SessionTree } from '@inkpi/agent-core';
import type { AgentMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core -> Session Exporter', () => {
  it('should export session messages and thinking traces into interactive HTML and Markdown', () => {
    const exporter = new SessionExporter();
    const tree = new SessionTree();

    const messages: AgentMessage[] = [
      { id: 'm1', role: 'user', content: '请推演主角在万剑归宗大阵下的破局之策' },
      {
        id: 'm2',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '计算剑阵七星阵眼的灵力周转薄弱点...' },
          { type: 'text', text: '主角祭出本命飞剑，以虚晃一枪直取天玑星位！' },
          { type: 'toolCall', id: 'tc1', name: 'lookup_codex', arguments: { query: '七星剑阵' } }
        ]
      },
      {
        id: 'm3',
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'lookup_codex',
        content: [{ type: 'text', text: '天玑星位乃阵眼虚实转换之门' }]
      }
    ];

    tree.addMessage(messages[0]);
    tree.addMessage(messages[1], 'm1');

    // 1. HTML Export
    const html = exporter.exportToHtml(messages, { format: 'html', title: '万剑归宗战役推演' }, tree);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('万剑归宗战役推演');
    expect(html).toContain('计算剑阵七星阵眼的灵力周转薄弱点...');
    expect(html).toContain('lookup_codex');

    // 2. Markdown Export
    const md = exporter.exportToMarkdown(messages, { format: 'markdown', title: '万剑归宗战役推演' });
    expect(md).toContain('# 万剑归宗战役推演');
    expect(md).toContain('## User');
    expect(md).toContain('💡 **Thinking**');
    expect(md).toContain('主角祭出本命飞剑');
  });

  it('should use injected presentation labels and escape structured content', () => {
    const exporter = new SessionExporter();
    const html = exporter.exportToHtml(
      [
        { id: 'sys', role: 'system', content: 'system <instruction>' },
        { id: 'custom', role: 'custom', customType: 'event', content: { value: '<raw>' } },
        {
          id: 'assistant',
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call', name: 'inspect', arguments: { value: '<raw>' } }]
        }
      ],
      {
        format: 'html',
        labels: {
          user: 'Input',
          assistant: 'Output',
          toolCall: 'Invoke',
          system: 'Protocol',
          custom: 'Extension Event'
        }
      }
    );

    expect(html).toContain('Protocol');
    expect(html).toContain('Extension Event');
    expect(html).toContain('Invoke');
    expect(html).toContain('&lt;raw&gt;');
    expect(html).not.toContain('作者指令');
    expect(html).not.toContain('AI 创作响应');
  });
});
