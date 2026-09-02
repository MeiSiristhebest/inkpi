import { SessionShareExporter, SessionTree } from '@inkpi/agent-core';
import type { AgentMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('Creative Session Share & Dataset Generation (1:1 Ported from pi-share-hf)', () => {
  it('should sanitize sensitive API keys and local paths from texts and messages', () => {
    const rawText =
      'My secret key is sk-abcdef1234567890123456 and files are located in C:\\Users\\Author\\Documents\\novel.txt';
    const sanitized = SessionShareExporter.sanitize(rawText);

    expect(sanitized).not.toContain('sk-abcdef1234567890123456');
    expect(sanitized).not.toContain('C:\\Users\\Author\\Documents\\novel.txt');
    expect(sanitized).toContain('[REDACTED_API_KEY]');
    expect(sanitized).toContain('[REDACTED_LOCAL_PATH]');

    const rawMsg: AgentMessage = {
      id: 'm1',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Checking path /home/ubuntu/secrets/key.pem with key-1234567890abcdef' },
        { type: 'text', text: 'Loaded context from Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9' },
        {
          type: 'toolCall',
          id: 'tc1',
          name: 'read_file',
          arguments: { path: 'C:\\Users\\Mei\\secret.json' }
        }
      ]
    };

    const sanitizedMsg = SessionShareExporter.sanitizeMessage(rawMsg);
    expect(JSON.stringify(sanitizedMsg)).not.toContain('/home/ubuntu/secrets/key.pem');
    expect(JSON.stringify(sanitizedMsg)).not.toContain('C:\\Users\\Mei\\secret.json');
    expect(JSON.stringify(sanitizedMsg)).toContain('[REDACTED_LOCAL_PATH]');
  });

  it('should export structured dataset payload with branches, ledger, and metadata', () => {
    const tree = new SessionTree();
    tree.addMessage({ id: 'root_1', role: 'user', content: '根节点' });
    tree.addBranchMarker('Alternative Climax Branch');

    const messages: AgentMessage[] = [
      { id: 'm1', role: 'user', content: '第一幕：主角在破晓时分启程。' },
      {
        id: 'm2',
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '规划三条伏笔与因果收束' },
          { type: 'text', text: '东方泛起鱼肚白，长剑在微光下泛起寒芒。' }
        ]
      }
    ];

    const dataset = SessionShareExporter.exportDataset(
      {
        messages,
        tree,
        stateLedger: {
          entities: [{ name: '叶孤城', status: '健康' }],
          assets: [{ name: '天外飞仙剑谱', holder: '叶孤城' }],
          tracks: [],
          locations: [],
          modifiedResources: []
        },
        systemPrompt: 'You are a martial arts master co-writer.'
      },
      {
        title: '剑试九天第一卷演化分支',
        author: '云中客',
        tags: ['wuxia', 'branch-simulation']
      }
    );

    expect(dataset.version).toBe('1.0');
    expect(dataset.title).toBe('剑试九天第一卷演化分支');
    expect(dataset.author).toBe('云中客');
    expect(dataset.tags).toContain('wuxia');
    expect(dataset.stats.turnsCount).toBe(1);
    expect(dataset.stats.branchesCount).toBeGreaterThanOrEqual(1);
    expect(dataset.stats.entitiesCount).toBe(1);
    expect(dataset.stateLedger?.entities?.[0].name).toBe('叶孤城');

    // Export HTML test
    const html = SessionShareExporter.exportShareHtml(dataset);
    expect(html).toContain('剑试九天第一卷演化分支');
    expect(html).toContain('云中客');
    expect(html).toContain('规划三条伏笔与因果收束');
    expect(html).toContain('东方泛起鱼肚白');

    // Test with excluded thinking, excluded tool calls, and custom patterns
    const datasetFiltered = SessionShareExporter.exportDataset(
      { messages, systemPrompt: 'secret password is 12345' },
      {
        includeThinking: false,
        includeToolCalls: false,
        includeStateLedger: false,
        includeSessionTree: false,
        customRedactPatterns: [/password is \d+/g]
      }
    );
    expect(datasetFiltered.stateLedger).toBeUndefined();
    expect(datasetFiltered.branches).toBeUndefined();
    expect(datasetFiltered.systemPrompt).toContain('[REDACTED]');
    const asstMsg = datasetFiltered.messages.find((m) => m.role === 'assistant')!;
    expect((asstMsg.content as any[]).some((b) => b.type === 'thinking')).toBe(false);

    // Empty and non-string sanitize
    expect(SessionShareExporter.sanitize('')).toBe('');
    expect(SessionShareExporter.sanitize(null as any)).toBeNull();
  });
});
