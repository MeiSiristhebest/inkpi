import { describe, it, expect, vi } from 'vitest';
import { Agent, ToolRegistry, ExtensionHost, SessionTree } from '@meisiristhebest/agent-core';
import {
  HeadlessEditorState,
  GhostTextManager,
  formatChineseTypography,
  formatWesternTypography
} from '@meisiristhebest/editor-core';
import { InkDb, InkRepository, CompactionEngine } from '@meisiristhebest/storage';
import {
  mockProvider,
  deepSeekProvider,
  ollamaProvider,
  getModelPreset,
  registerProvider,
  getProvider,
  streamAi
} from '@meisiristhebest/ai';
import type { AgentMessage, AgentEvent } from '@meisiristhebest/protocol';

describe('Headless Core In-Depth Branch Coverage Suite', () => {
  it('should test Agent loop hooks, termination, queue modes, onUpdate events and abort', async () => {
    const events: AgentEvent[] = [];

    // 1. beforeToolCall termination and custom reason, with tool onUpdate execution
    const agent = new Agent({
      steeringMode: 'one-at-a-time',
      followUpMode: 'all',
      toolExecution: 'sequential',
      initialState: {
        thinkingLevel: 'off',
        model: getModelPreset('mock-test')
      },
      beforeToolCall: async ({ toolCall }) => {
        if (toolCall.name === 'block_tool') {
          return { block: true, reason: '门禁阻断', terminate: true };
        }
      },
      shouldStopAfterTurn: async () => true
    });

    agent.subscribe((ev) => events.push(ev));

    agent.getToolRegistry().register({
      name: 'update_tool',
      description: 'update tool',
      execute: async (_id, _p, _signal, onUpdate) => {
        onUpdate?.({ content: [{ type: 'text', text: '50%' }] });
        return { content: [{ type: 'text', text: '100%' }] };
      }
    });

    agent.getToolRegistry().register({
      name: 'block_tool',
      description: 'blocked tool',
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] })
    });

    await agent.prompt('lookup_codex');
    expect(agent.state.messages.length).toBeGreaterThan(0);

    // 2. afterToolCall full overrides
    const agent2 = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      afterToolCall: async () => ({
        content: [{ type: 'text', text: '覆写内容' }],
        details: { overridden: true },
        isError: true,
        terminate: true
      })
    });
    await agent2.prompt('lookup_codex');
    expect(agent2.state.messages.length).toBeGreaterThan(0);
  });

  it('should test editor-core AST state, empty paragraph nodes, ghost text edge cases, and typography branches', () => {
    const editor = new HeadlessEditorState();
    expect(editor.undo()).toBe(false);
    expect(editor.redo()).toBe(false);

    editor.setSelection(0, 5);
    expect(editor.getSelection()).toEqual({ from: 0, to: 5 });

    // Empty paragraph nodes branch coverage
    (editor as any).doc = { type: 'doc', content: [{ type: 'paragraph' }] };
    expect(editor.getText()).toBe('');

    (editor as any).doc = { type: 'doc' };
    expect(editor.getText()).toBe('');

    editor.setContent('内容\n\n');
    expect(editor.getText()).toBe('内容\n\n');

    editor.clearHistory();
    expect(editor.getUndoStackDepth()).toBe(0);

    const ghost = new GhostTextManager(editor);
    expect(ghost.acceptGhostText()).toBe(false);
    expect(ghost.getGhostText()).toBeNull();
    expect(ghost.getState().active).toBe(false);

    // Typography branches
    expect(formatChineseTypography('文本', { enabled: false })).toBe('文本');
    expect(formatChineseTypography('   \u3000已缩进')).toContain('\u3000\u3000已缩进');
    expect(formatWesternTypography('')).toBe('');
  });

  it('should test storage repository and compaction delta replay branches', () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const compaction = new CompactionEngine(db, repo);

    // Null lookups
    expect(repo.getWorkspace('non_existent')).toBeUndefined();
    expect(repo.getDocument('non_existent')).toBeUndefined();
    expect(repo.getSnapshot('non_existent')).toBeUndefined();

    // Replay delete and replace deltas
    const now = Date.now();
    repo.createWorkspace({ id: 'b_t', title: 't', owner: 'a', category: 'g', targetSize: 10, createdAt: now, updatedAt: now });
    repo.createFolder({ id: 'v_t', workspaceId: 'b_t', title: 'v', orderIndex: 1, createdAt: now, updatedAt: now });
    repo.createDocument({ id: 'ch_t', folderId: 'v_t', workspaceId: 'b_t', title: 'c', orderIndex: 1, contentSize: 0, status: 'draft', createdAt: now, updatedAt: now });

    repo.appendDelta({
      documentId: 'ch_t',
      stepJson: JSON.stringify({ type: 'insert', text: 'ABCDEF' }),
      clientTimestamp: now,
      createdAt: now
    });
    repo.appendDelta({
      documentId: 'ch_t',
      stepJson: JSON.stringify({ type: 'delete', from: 1, to: 3 }),
      clientTimestamp: now + 1,
      createdAt: now + 1
    });
    repo.appendDelta({
      documentId: 'ch_t',
      stepJson: JSON.stringify({ type: 'replace', text: 'REPLACED_TEXT' }),
      clientTimestamp: now + 2,
      createdAt: now + 2
    });

    const recovery = compaction.recoverDocument('ch_t');
    expect(recovery.contentMarkdown).toBe('REPLACED_TEXT');
    expect(recovery.replayedDeltasCount).toBe(3);
    expect(recovery.recoveryErrors).toEqual([]);

    db.checkpoint();
    db.close();
  });

  it('should fail strict recovery on malformed deltas and report them in lenient mode', () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const compaction = new CompactionEngine(db, repo);
    const now = Date.now();

    repo.createWorkspace({ id: 'b_bad_delta', title: 't', owner: 'a', createdAt: now, updatedAt: now });
    repo.createFolder({ id: 'v_bad_delta', workspaceId: 'b_bad_delta', title: 'v', orderIndex: 1, createdAt: now, updatedAt: now });
    repo.createDocument({ id: 'ch_bad_delta', folderId: 'v_bad_delta', workspaceId: 'b_bad_delta', title: 'c', orderIndex: 1, contentSize: 0, status: 'draft', createdAt: now, updatedAt: now });
    repo.appendDelta({
      documentId: 'ch_bad_delta',
      stepJson: '{not-json}',
      clientTimestamp: now,
      createdAt: now
    });

    expect(() => compaction.recoverDocument('ch_bad_delta')).toThrow(/Failed to replay delta/);
    const errors: string[] = [];
    const recovered = compaction.recoverDocument('ch_bad_delta', {
      strict: false,
      onError: (error) => errors.push(error.message)
    });
    expect(recovered.replayedDeltasCount).toBe(0);
    expect(recovered.recoveryErrors).toHaveLength(1);
    expect(errors).toEqual(recovered.recoveryErrors.map((error) => error.message));
    db.close();
  });

  it('should test AI providers error, null body, abort, provider registry and fallback branches', async () => {
    const originalFetch = globalThis.fetch;

    // 1. DeepSeek provider API error
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized'
    }) as any;

    try {
      const stream = deepSeekProvider(
        { id: 'deepseek-chat', name: 'DS', provider: 'deepseek', apiKey: 'invalid-key' },
        [{ role: 'user', content: 'hi' }]
      );
      const res = await stream.collect();
      expect(res.stopReason).toBe('error');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 2. Ollama provider null body
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null
    }) as any;

    try {
      const stream = ollamaProvider(
        { id: 'qwen2.5', name: 'Ollama', provider: 'ollama' },
        [{ role: 'user', content: 'hi' }]
      );
      const res = await stream.collect();
      expect(res.stopReason).toBe('error');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 3. Ollama provider network error -> genuine error emission (no silent mock)
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as any;

    try {
      const stream = ollamaProvider(
        { id: 'qwen2.5', name: 'Ollama', provider: 'ollama' },
        [{ role: 'user', content: 'hi' }]
      );
      const res = await stream.collect();
      expect(res.stopReason).toBe('error');
      expect(res.errorMessage).toContain('Ollama connection error');
    } finally {
      globalThis.fetch = originalFetch;
    }


    // 4. DeepSeek provider AbortError
    globalThis.fetch = vi.fn().mockRejectedValue({
      name: 'AbortError',
      message: 'Aborted'
    }) as any;

    try {
      const stream = deepSeekProvider(
        { id: 'deepseek-chat', name: 'DS', provider: 'deepseek', apiKey: 'sk-test' },
        [{ role: 'user', content: 'hi' }]
      );
      const res = await stream.collect();
      expect(res.stopReason).toBe('aborted');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 5. DeepSeek provider Network Error (generic)
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection reset')) as any;

    try {
      const stream = deepSeekProvider(
        { id: 'deepseek-chat', name: 'DS', provider: 'deepseek', apiKey: 'sk-test' },
        [{ role: 'user', content: 'hi' }]
      );
      const res = await stream.collect();
      expect(res.stopReason).toBe('error');
      expect(res.errorMessage).toContain('Connection reset');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 6. Ollama provider 500 response error
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error'
    }) as any;

    try {
      const stream = ollamaProvider(
        { id: 'qwen2.5', name: 'Ollama', provider: 'ollama' },
        [{ role: 'user', content: 'hi' }]
      );
      const res = await stream.collect();
      expect(res.stopReason).toBe('error');
      expect(res.errorMessage).toContain('500');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 7. DeepSeek provider null body
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: null
    }) as any;

    try {
      const streamNull = deepSeekProvider(
        { id: 'deepseek-chat', name: 'DS', provider: 'deepseek', apiKey: 'sk-test' },
        [{ role: 'user', content: 'hi' }]
      );
      const res = await streamNull.collect();
      expect(res.stopReason).toBe('error');
      expect(res.errorMessage).toContain('No response body');
    } finally {
      globalThis.fetch = originalFetch;
    }

    // 8. Provider registry register and streamAi
    registerProvider('custom', mockProvider);
    expect(getProvider('custom')).toBe(mockProvider);
    const unkHandler = getProvider('unknown' as any);
    expect(unkHandler).toBeDefined();
    const unkStream = unkHandler(getModelPreset('mock-test'), []);
    const unkMsg = await unkStream.collect();
    expect(unkMsg.stopReason).toBe('error');

    const stream = streamAi(getModelPreset('mock-test'), [{ role: 'user', content: 'test' }]);
    const msg = await stream.collect();
    expect(msg.role).toBe('assistant');
  });

  it('should test ToolRegistry, SessionTree DAG edge cases, and Agent abort', async () => {
    const reg = new ToolRegistry();
    const emptyBatch = await reg.executeBatch([]);
    expect(emptyBatch.length).toBe(0);

    const agent = new Agent({
      toolExecution: 'sequential',
      initialState: { model: getModelPreset('mock-test') },
      transformContext: async (msgs) => msgs
    });

    expect(agent.getExtensionHost()).toBeDefined();
    expect(agent.getExtensionRunner()).toBeDefined();

    agent.getToolRegistry().register({
      name: 'seq_tool',
      description: 'seq tool',
      execute: async () => ({ content: [{ type: 'text', text: 'seq result' }] })
    });

    const runP = agent.prompt('lookup_codex');
    agent.abort();
    await runP;
    expect(agent.state.messages.length).toBeGreaterThan(0);

    // Western typography
    expect(formatWesternTypography('  hello   world  ')).toBe('hello world');

    // SessionTree initial messages and fork error
    const msgInit: AgentMessage = { role: 'user', content: 'init' };
    const treeWithInit = new SessionTree([msgInit]);
    expect(treeWithInit.size()).toBe(1);
    expect(() => treeWithInit.fork('non_existing')).toThrow();

    // Editor multi-line insert and word count combinations
    const wcTest = new HeadlessEditorState('Hello World 123');
    expect(wcTest.getWordCount()).toBe(3);

    const cnOnlyTest = new HeadlessEditorState('纯中文正文测试');
    expect(cnOnlyTest.getWordCount()).toBe(7);

    const editTest = new HeadlessEditorState();
    editTest.insertText(0, '第一行\n\n第三行\n');
    expect(editTest.getText()).toContain('第一行');

    // Typography multi-paragraph test
    const formatted = formatChineseTypography('第一段\n\n第二段', { indentSpaces: 2 });
    expect(formatted).toContain('\u3000\u3000第一段');

    // A real provider without credentials must surface an error, never a fake success.
    const noKeyStream = deepSeekProvider(
      { id: 'deepseek-chat', name: 'DS', provider: 'deepseek', apiKey: '' },
      [{ role: 'user', content: 'test' }]
    );
    const noKeyMsg = await noKeyStream.collect();
    expect(noKeyMsg.role).toBe('assistant');
    expect(noKeyMsg.stopReason).toBe('error');
    expect(noKeyMsg.errorMessage).toContain('Missing API key');
  });

  it('should test Agent prompt with images, AgentMessage object, and tool terminate flag', async () => {
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') }
    });

    // Prompt with images
    await agent.prompt('带图提示词', [{ type: 'image', image: 'base64...' }]);

    // Prompt with AgentMessage object
    await agent.prompt({ role: 'user', content: '对象消息' });

    // Steer and followUp
    agent.steer({ role: 'user', content: '纠偏指令' });
    agent.followUp({ role: 'user', content: '追问指令' });

    agent.getToolRegistry().register({
      name: 'terminating_tool',
      description: 'term tool',
      execute: async () => ({ content: [{ type: 'text', text: 'stop' }], terminate: true })
    });

    await agent.prompt('lookup_codex');
    expect(agent.state.messages.length).toBeGreaterThan(0);

    // MockProvider with image content
    const imgStream = mockProvider(
      getModelPreset('mock-test'),
      [{ role: 'user', content: [{ type: 'image', image: 'test.png' }] }]
    );
    const imgMsg = await imgStream.collect();
    expect(imgMsg.role).toBe('assistant');

    // Editor multi-line and multi-span deleteRange
    const spanEditor = new HeadlessEditorState('Line 1\nLine 2\nLine 3');
    spanEditor.deleteRange(2, 10);
    expect(spanEditor.getText()).toBe('Lie 2\nLine 3');
  });

  it('should test InkDb default path, transaction rollback, and repository CRUD queries', () => {
    const db = new InkDb(); // default ':memory:'
    expect(db.getPath()).toBe(':memory:');

    // Transaction rollback on error
    expect(() => {
      db.transaction(() => {
        db.exec("CREATE TABLE test_tbl (id TEXT PRIMARY KEY)");
        throw new Error('Rollback test');
      });
    }).toThrow('Rollback test');

    const repo = new InkRepository(db);
    const now = Date.now();
    repo.createWorkspace({ id: 'b_del', title: 'd', owner: 'a', category: 'g', targetSize: 10, createdAt: now, updatedAt: now });
    repo.createFolder({ id: 'v_del', workspaceId: 'b_del', title: 'v', orderIndex: 1, createdAt: now, updatedAt: now });
    repo.createDocument({ id: 'ch_del', folderId: 'v_del', workspaceId: 'b_del', title: 'c', orderIndex: 1, contentSize: 0, status: 'draft', createdAt: now, updatedAt: now });

    expect(repo.getFolders('b_del').length).toBe(1);
    expect(repo.getDocuments('v_del').length).toBe(1);
    expect(repo.getDocument('ch_del')?.title).toBe('c');

    db.close();
  });
});
