import { describe, it, expect } from 'vitest';
import { Agent } from '@inkpi/agent-core';
import { HeadlessEditorState, GhostTextManager } from '@inkpi/editor-core';
import { InkDb, InkRepository, CompactionEngine } from '@inkpi/storage';
import { getModelPreset } from '@inkpi/ai';
import type { AgentEvent, ExtensionAPI } from '@inkpi/protocol';

describe('InkPi E2E Headless Core Pipeline (Microkernel & Dynamic Extension Loading)', () => {
  it('should execute end-to-end writer plot with Agent, Editor, Storage, and Dynamic Extension', async () => {
    // 1. Initialize Storage & Project Container
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const compaction = new CompactionEngine(db, repo);

    const now = Date.now();
    repo.createWorkspace({
      id: 'workspace_e2e',
      title: 'Main Creative Project',
      owner: 'Creator User',
      category: 'general',
      targetSize: 500000,
      createdAt: now,
      updatedAt: now
    });
    repo.createFolder({
      id: 'vol_e2e_1',
      workspaceId: 'workspace_e2e',
      title: 'Folder 1 Prologue',
      orderIndex: 1,
      createdAt: now,
      updatedAt: now
    });
    repo.createDocument({
      id: 'ch_e2e_1',
      folderId: 'vol_e2e_1',
      workspaceId: 'workspace_e2e',
      title: 'Document 1 Genesis',
      orderIndex: 1,
      contentSize: 0,
      status: 'draft',
      createdAt: now,
      updatedAt: now
    });

    // 2. Initialize Headless Editor State Machine
    const editor = new HeadlessEditorState();
    const ghost = new GhostTextManager(editor);

    // 3. Writer types initial sentence in editor
    editor.insertText(0, '夜幕低垂，窗外的风声越来越大。');

    // 4. Append keystroke delta to storage
    repo.appendDelta({
      documentId: 'ch_e2e_1',
      stepJson: JSON.stringify({ type: 'insert', from: 0, text: '夜幕低垂，窗外的风声越来越大。' }),
      clientTimestamp: Date.now(),
      createdAt: Date.now()
    });

    // 5. Initialize Headless Agent Microkernel
    const agent = new Agent({
      initialState: {
        model: getModelPreset('mock-test')
      }
    });

    // 6. Dynamic Extension Loading via ExtensionAPI (Simulating user/community custom extension)
    const customWriterPlugin = (pi: ExtensionAPI) => {
      // Dynamic Tool registration
      pi.registerTool({
        name: 'world_query',
        description: '动态世界观检索工具',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
        execute: async (_callId, params) => ({
          content: [{ type: 'text', text: `【检索结果】关于「${params.query}」的设定信息。` }]
        })
      });

      // Dynamic Context Transformer (injecting relevant metadata before LLM inference)
      pi.addContextTransformer(async (messages) => {
        return [
          { role: 'custom', customType: 'dynamic_lore', content: '<context>角色设定</context>' },
          ...messages
        ];
      });
    };

    const loaded = await agent.getExtensionRunner().loadExtension(customWriterPlugin, 'custom-writer-plugin');
    expect(loaded).toBe(true);

    const emittedEvents: AgentEvent[] = [];
    agent.subscribe((ev) => emittedEvents.push(ev));

    // 7. Request Agent to continue with context awareness and tool execution
    await agent.prompt('lookup_codex 请续写下一句。');

    expect(agent.state.messages.length).toBeGreaterThan(1);
    expect(emittedEvents.some((e) => e.type === 'agent_end')).toBe(true);

    // 8. Editor receives stream and projects inline Ghost Text (Zero AST pollution)
    const astVersionBeforeGhost = editor.getVersion();
    ghost.setGhostText(editor.getText().length, '他握紧了腰间的佩剑，目光警惕。');

    expect(ghost.hasGhostText()).toBe(true);
    expect(editor.getVersion()).toBe(astVersionBeforeGhost); // Zero AST pollution!

    // 9. Writer presses Tab to accept Ghost Text
    const accepted = ghost.acceptGhostText();
    expect(accepted).toBe(true);
    expect(editor.getText()).toContain('他握紧了腰间的佩剑');
    expect(editor.getVersion()).toBeGreaterThan(astVersionBeforeGhost);

    // 10. Record accepted text to storage & run Snapshot Compaction
    repo.appendDelta({
      documentId: 'ch_e2e_1',
      stepJson: JSON.stringify({ type: 'insert', from: 16, text: '他握紧了腰间的佩剑，目光警惕。' }),
      clientTimestamp: Date.now(),
      createdAt: Date.now()
    });

    const compactionResult = compaction.saveSnapshotAndCompact(
      'ch_e2e_1',
      1,
      JSON.stringify(editor.getDoc()),
      editor.getText(),
      editor.getWordCount()
    );

    expect(compactionResult.deletedDeltas).toBeGreaterThanOrEqual(1);

    // 11. Test idempotent crash recovery
    const recovered = compaction.recoverDocument('ch_e2e_1');
    expect(recovered.contentMarkdown).toBe(editor.getText());
    expect(recovered.contentSize).toBe(editor.getWordCount());

    db.close();
  });
});
