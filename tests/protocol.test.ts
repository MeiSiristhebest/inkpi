import type {
  AgentMessage,
  AgentTool,
  AssistantMessage,
  Document,
  DocumentDelta,
  DocumentSnapshot,
  Folder,
  ShortcutHandler,
  SlashCommand,
  ToolResultMessage,
  UserMessage,
  Workspace
} from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('@inkpi/protocol (Pure Zero-Bias Protocol Contracts)', () => {
  it('should instantiate and validate standard message types', () => {
    const userMsg: UserMessage = {
      role: 'user',
      content: '请根据大纲继续生成',
      timestamp: Date.now()
    };

    const assistantMsg: AssistantMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '梳理因果冲突与主线动机。' },
        { type: 'text', text: '风folder长林，落叶纷飞。' }
      ],
      stopReason: 'stop',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }
    };

    const toolResultMsg: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: 'call_01',
      toolName: 'custom_tool',
      content: [{ type: 'text', text: '执行成功' }],
      isError: false
    };

    const messages: AgentMessage[] = [userMsg, assistantMsg, toolResultMsg];
    expect(messages.length).toBe(3);
    expect(messages[0].role).toBe('user');
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('toolResult');
  });

  it('should validate storage relational entities', () => {
    const workspace: Workspace = {
      id: 'workspace_1',
      title: 'author品全集',
      owner: 'author家',
      category: 'general',
      targetSize: 500000,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const folder: Folder = {
      id: 'vol_1',
      workspaceId: 'workspace_1',
      title: '第一folder',
      orderIndex: 1,
      summary: '分folder概括',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const document: Document = {
      id: 'ch_1',
      folderId: 'vol_1',
      workspaceId: 'workspace_1',
      title: '第一document',
      orderIndex: 1,
      contentSize: 3000,
      status: 'draft',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const snapshot: DocumentSnapshot = {
      documentId: 'ch_1',
      version: 1,
      contentJson: '{"type":"doc","content":[]}',
      contentMarkdown: '# 第一document',
      contentSize: 10,
      updatedAt: Date.now()
    };

    const delta: DocumentDelta = {
      documentId: 'ch_1',
      stepJson: '{"type":"insert","text":"正文"}',
      clientTimestamp: Date.now(),
      createdAt: Date.now()
    };

    expect(workspace.title).toBe('author品全集');
    expect(folder.orderIndex).toBe(1);
    expect(document.status).toBe('draft');
    expect(snapshot.version).toBe(1);
    expect(delta.documentId).toBe('ch_1');
  });

  it('should validate extension API and tool schemas', () => {
    const tool: AgentTool<{ query: string }> = {
      name: 'search_lore',
      description: '通用检索工具',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: { query: { type: 'string' } }
      },
      execute: async (_callId, params) => ({
        content: [{ type: 'text', text: params.query }]
      })
    };

    const cmd: SlashCommand = {
      name: 'help',
      description: '帮助指令',
      execute: async () => '帮助信息'
    };

    const shortcut: ShortcutHandler = {
      key: 'Ctrl+S',
      description: '保存',
      execute: async () => true
    };

    expect(tool.name).toBe('search_lore');
    expect(cmd.name).toBe('help');
    expect(shortcut.key).toBe('Ctrl+S');
  });
});
