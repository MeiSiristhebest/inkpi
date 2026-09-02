import { SessionReportExporter, SessionTree } from '@inkpi/agent-core';
import type { AgentMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('SessionReportExporter', () => {
  it('renders protocol data without narrative defaults', () => {
    const tree = new SessionTree();
    const user: AgentMessage = { id: 'u1', role: 'user', content: 'inspect this state' };
    const assistant: AgentMessage = {
      id: 'a1',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'reason about the state' },
        { type: 'text', text: 'state is consistent' },
        { type: 'toolCall', id: 't1', name: 'inspect', arguments: { path: '<safe>' } }
      ]
    };
    tree.addMessage(user);
    tree.addMessage(assistant);

    const html = new SessionReportExporter().exportToHtml(
      [user, assistant],
      {
        title: 'Protocol Report',
        exportedAt: '2026-01-02T03:04:05.000Z',
        ledger: {
          entities: [{ name: 'runtime', status: 'ready', attributes: { value: '<escaped>' } }],
          assets: [{ name: 'resource', owner: 'system', state: 'available' }],
          tracks: [{ id: 't', summary: 'checkpoint', status: 'pending' }],
          locations: [],
          modifiedResources: []
        },
        branchSummaries: [{ branchName: 'alternate', summaryText: 'different execution path', differenceCount: 2 }],
        gateIssues: [{ type: 'validation', severity: 'warning', description: 'needs review' }],
        labels: {
          user: 'Input',
          assistant: 'Output',
          toolCall: 'Invoke',
          timeline: 'Events'
        }
      },
      tree
    );

    expect(html).toContain('Protocol Report');
    expect(html).toContain('Input #1');
    expect(html).toContain('Invoke');
    expect(html).toContain('alternate');
    expect(html).toContain('&lt;escaped&gt;');
    expect(html).toContain('2026-01-02T03:04:05.000Z');
    expect(html).not.toContain('作者指令');
    expect(html).not.toContain('AI 创作响应');
  });

  it('preserves branch counts and reports empty data explicitly', () => {
    const tree = new SessionTree();
    tree.addMessage({ id: 'root', role: 'user', content: 'root' });
    const html = new SessionReportExporter().exportToHtml([], { exportedAt: 0 }, tree);

    expect(html).toContain('Branches (1)');
    expect(html).toContain('1 Branches');
    expect(html).toContain('No state records.');
    expect(html).toContain('No gate issues detected.');
  });
});
