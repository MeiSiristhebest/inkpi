import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  InkRpcServer,
  InkRpcClient,
  InMemoryTransport,
  ProjectTrustManager,
  runPrintMode,
  Editor,
  SelectList,
  parseKey,
  Agent,
  SessionTree,
  SlashCommandRegistry,
  TelemetryCollector,
  KillRing,
  MockClipboardDriver,
  SyncedClipboard
} from '@inkpi/agent-core';
import { HeadlessEditorState, GhostTextManager } from '@inkpi/editor-core';
import { AppendOnlySessionJournal, InkDb, FtsSearchEngine } from '@inkpi/storage';
import {
  validateSchema,
  sanitizeStateLedger,
  StateLedgerSchema
} from '@inkpi/protocol';
import {
  convertMessagesToStandard,
  setFauxScript,
  getModelPreset,
  streamAi
} from '@inkpi/ai';

describe('System Integration & Edge Cases Suite', () => {
  it('should test InkRpcServer uninitialized component branches', async () => {
    const emptyServer = new InkRpcServer({});

    const expectError = async (method: string, params?: any) => {
      const res = await emptyServer.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method,
        params
      });
      expect(res.error).toBeDefined();
    };

    await expectError('agent.prompt', { prompt: 'hi' });
    await expectError('agent.steer', { message: 'hi' });
    await expectError('agent.followUp', { message: 'hi' });
    await expectError('agent.getState');
    await expectError('agent.abort');

    await expectError('editor.insertText', { text: 'hi' });
    await expectError('editor.replaceRange', { start: 0, end: 1, text: 'hi' });
    await expectError('editor.undo');
    await expectError('editor.redo');

    await expectError('ghost.suggest', { text: 'hi' });
    await expectError('ghost.accept');
    await expectError('ghost.dismiss');

    await expectError('tree.branch', { name: 'branch' });
    await expectError('tree.fork', {});
    await expectError('tree.switchBranch', { nodeId: 'n1' });
    await expectError('tree.getSummary');

    await expectError('pipeline.run', {});
    await expectError('journal.append', { type: 'test', payload: {} });
    await expectError('jit.retrieve', {});

    // Methods that return empty defaults
    const editorText = await emptyServer.handleRequest({ jsonrpc: '2.0', id: 2, method: 'editor.getText' });
    expect(editorText.result).toBe('');

    const branches = await emptyServer.handleRequest({ jsonrpc: '2.0', id: 3, method: 'tree.getBranches' });
    expect(branches.result).toEqual([]);

    const journalEntries = await emptyServer.handleRequest({ jsonrpc: '2.0', id: 4, method: 'journal.getEntries' });
    expect(journalEntries.result).toEqual([]);

    const fts = await emptyServer.handleRequest({ jsonrpc: '2.0', id: 5, method: 'storage.searchFts', params: { query: 'test' } });
    expect(fts.result).toEqual([]);

    const stats = await emptyServer.handleRequest({ jsonrpc: '2.0', id: 6, method: 'telemetry.getStats' });
    expect(stats.result).toBeDefined();

    const otel = await emptyServer.handleRequest({ jsonrpc: '2.0', id: 7, method: 'telemetry.exportOtel' });
    expect(otel.result).toBe('{}');
  });

  it('should test all InkRpcClient helper methods on full server', async () => {
    const editor = new HeadlessEditorState('初始章节内容');
    const ghost = new GhostTextManager(editor);
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test'), systemPrompt: '测试' }
    });
    const tree = new SessionTree([
      { id: 'm1', role: 'user', content: '第一句', timestamp: Date.now() },
      { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '回答' }], timestamp: Date.now() }
    ]);
    const journal = new AppendOnlySessionJournal('test_sess');
    const slashRegistry = new SlashCommandRegistry();
    const telemetry = new TelemetryCollector();
    const db = new InkDb(':memory:');
    const fts = new FtsSearchEngine(db);

    const fullServer = new InkRpcServer({
      editor,
      ghost,
      agent,
      tree,
      journal,
      slashRegistry,
      telemetry,
      fts
    });

    const client = new InkRpcClient(new InMemoryTransport(fullServer));

    // Agent methods
    await client.prompt('写一段正文');
    await client.steer('修改语气');
    await client.followUp('再补充细节');
    const agentState = await client.getAgentState();
    expect(agentState).toBeDefined();
    await client.abortAgent();

    // Editor & Ghost methods
    await client.insertEditorText(0, '前缀 ');
    await client.replaceEditorRange(0, 3, '开头');
    await client.undoEditor();
    await client.redoEditor();
    await client.suggestGhost('推荐后续情节');
    await client.dismissGhost();

    // Tree methods
    await client.branchTree('if_branch_1', '如果主角没有掉下悬崖');
    await client.navigateTree('m1');
    await client.getBranchSummary();

    // Slash & Fts & Telemetry
    await client.executeSlash('/help');
    await client.searchFts('章节');
    await client.getTelemetry();
  });

  it('should test ProjectTrustManager file read/parse recovery branches', () => {
    const tmpTrustCorrupted = path.join(process.cwd(), '.tmp-corrupted-trust.json');
    fs.writeFileSync(tmpTrustCorrupted, '{ bad json file', 'utf8');
    const mgr1 = new ProjectTrustManager(tmpTrustCorrupted);
    expect(mgr1.listTrusted().length).toBe(0);
    fs.unlinkSync(tmpTrustCorrupted);

    const testPath = path.resolve(process.cwd(), 'trusted_proj');
    const tmpTrustValid = path.join(process.cwd(), '.tmp-valid-trust.json');
    fs.writeFileSync(tmpTrustValid, JSON.stringify([testPath]), 'utf8');
    const mgr2 = new ProjectTrustManager(tmpTrustValid);
    expect(mgr2.isTrusted(testPath)).toBe(true);
    fs.unlinkSync(tmpTrustValid);
  });

  it('should test runPrintMode with architect role, systemPrompt, thinkingLevel, and custom file output', async () => {
    const tmpFile = path.join(process.cwd(), '.tmp-writer-print.txt');
    const res = await runPrintMode({
      prompt: '请构思一段情节',
      role: 'architect',
      systemPrompt: '你是总策划',
      thinkingLevel: 'high',
      output: tmpFile,
      json: false
    });

    expect(res.success).toBe(true);
    expect(fs.existsSync(tmpFile)).toBe(true);
    fs.unlinkSync(tmpFile);
  });

  it('should test Editor and SelectList auxiliary branches', () => {
    const editor = new Editor({ text: 'Line 1\nLine 2', showLineNumbers: false });
    // Ctrl key ignored for text entry
    expect(editor.handleKey({ name: 'k', ctrl: true, meta: false, shift: false, raw: '\x0b', sequence: '\x0b' })).toBe(false);
    // Unknown special key ignored
    expect(editor.handleKey({ name: 'f10', ctrl: false, meta: false, shift: false, raw: '', sequence: '' })).toBe(false);

    // Insert character at position
    editor.cursorRow = 0;
    editor.cursorCol = 2;
    editor.handleKey({ name: 'Z', ctrl: false, meta: false, shift: false, raw: 'Z', sequence: 'Z' });
    expect(editor.lines[0]).toBe('LiZne 1');

    // Backspace inside line
    editor.handleKey(parseKey('\x7f'));
    expect(editor.lines[0]).toBe('Line 1');

    // Delete inside line
    editor.cursorCol = 2;
    editor.handleKey(parseKey('\x1b[3~'));
    expect(editor.lines[0]).toBe('Lie 1');

    // SelectList with empty items
    const emptyList = new SelectList({ title: '空列表', items: [] });
    expect(emptyList.render({ width: 30, height: 4 }).length).toBeGreaterThan(0);
    emptyList.handleKey(parseKey('\r'));
    emptyList.handleKey(parseKey('\x1b[A'));
    emptyList.handleKey(parseKey('\x1b[B'));
  });

  it('should test SyncedClipboard read and write methods with MockDriver', () => {
    const ring = new KillRing(5);
    const mockDriver = new MockClipboardDriver();
    const synced = new SyncedClipboard(ring, mockDriver);

    expect(mockDriver.readText()).toBe('');
    synced.copy('剪贴板测试');
    expect(mockDriver.readText()).toBe('剪贴板测试');
    expect(synced.paste()).toBe('剪贴板测试');
  });

  it('should test TypeBox schema validation errors and sanitization branches', () => {
    const invalidData = { entities: 'not-an-array' };
    const validRes = validateSchema(StateLedgerSchema, invalidData);
    expect(validRes.valid).toBe(false);
    expect(validRes.errors && validRes.errors.length > 0).toBe(true);

    const sanitized = sanitizeStateLedger({
      entities: [{ id: 'c1', name: '萧炎' }],
      assets: null as any
    });
    expect(sanitized.entities.length).toBe(1);
    expect(sanitized.assets).toEqual([]);
  });

  it('should test convertMessagesToStandard and fauxProvider scripts in AI layer', async () => {
    const stdMessages = convertMessagesToStandard([
      { role: 'user', content: [{ type: 'text', text: '用户文本块' }] },
      { role: 'assistant', content: [{ type: 'text', text: '助手回答' }] },
      { role: 'toolResult', toolCallId: 'tc_1', content: [{ type: 'text', text: '工具输出' }] }
    ], '系统提示词');

    expect(stdMessages.length).toBe(4);
    expect(stdMessages[0].role).toBe('system');
    expect(stdMessages[1].role).toBe('user');
    expect(stdMessages[2].role).toBe('assistant');
    expect(stdMessages[3].role).toBe('tool');

    // Faux provider script
    setFauxScript({
      thinking: '深度构思中...',
      text: '生成的测试正文',
      toolCalls: [{ id: 'tc_99', name: 'check_plot', arguments: {} }],
      inputTokens: 50,
      outputTokens: 30
    });

    const stream = streamAi(getModelPreset('mock-test'), [{ role: 'user', content: '测试' }]);
    const msg = await stream.collect();
    expect(msg.content.some((c) => c.type === 'thinking')).toBe(true);
    expect(msg.content.some((c) => c.type === 'toolCall')).toBe(true);
    setFauxScript(null);

    // Missing API keys for real providers
    const openaiStream = streamAi({ id: 'gpt-4o', name: 'GPT-4o', provider: 'openai', contextWindow: 128000, maxTokens: 4096 }, [{ role: 'user', content: 'hi' }]);
    const openaiMsg = await openaiStream.collect();
    expect(openaiMsg.errorMessage).toContain('Missing API key');

    const anthropicStream = streamAi({ id: 'claude-3-7-sonnet', name: 'Claude', provider: 'anthropic', contextWindow: 200000, maxTokens: 8192 }, [{ role: 'user', content: 'hi' }]);
    const anthropicMsg = await anthropicStream.collect();
    expect(anthropicMsg.errorMessage).toBeDefined();

    const geminiStream = streamAi({ id: 'gemini-2.5-pro', name: 'Gemini', provider: 'gemini', contextWindow: 1000000, maxTokens: 8192 }, [{ role: 'user', content: 'hi' }]);
    const geminiMsg = await geminiStream.collect();
    expect(geminiMsg.errorMessage).toBeDefined();
  });

  it('should test WorkflowCoordinator hooks, gate decisions, custom executor, and transformOutput branches', async () => {
    const { WorkflowCoordinator } = await import('@inkpi/agent-core');
    
    let beforeOutlineHit = false;
    let draftGenHit = false;
    let auditPassHit = false;
    let polishDoneHit = false;

    const coordinator = new WorkflowCoordinator({
      hooks: [{
        onBeforeOutline: async () => { beforeOutlineHit = true; return '大纲前置提示'; },
        onDraftGenerated: async () => { draftGenHit = true; return '正文后置修饰'; },
        onAuditPass: async () => { auditPassHit = true; },
        onPolishDone: async () => { polishDoneHit = true; return '润色完成版'; }
      }],
      enablePlotGate: true,
      plotGateHandler: async () => {
        return { approved: true, modifiedContent: '人工审查通过后的大纲' };
      }
    });

    // Add stage with transformOutput and executor
    coordinator.registerStage({
      id: 'custom_check',
      name: '自定义质检',
      role: 'polisher',
      executor: async () => ({ text: '质检文本', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } }),
      transformOutput: async (txt) => `【转换】${txt}`
    });

    const ctx = await coordinator.runPipeline('万相之王', '第一章', '测试创作指令');
    expect(ctx.polishedText).toBe('润色完成版');
    expect(beforeOutlineHit).toBe(true);
    expect(draftGenHit).toBe(true);
    expect(auditPassHit).toBe(true);
    expect(polishDoneHit).toBe(true);
    expect(ctx.stageOutputs['custom_check']).toBe('【转换】质检文本');

    // Test rejection in quality gate
    const rejectingCoordinator = new WorkflowCoordinator({
      enablePlotGate: true,
      plotGateHandler: async () => ({ approved: false, feedback: '设定严重冲突' })
    });
    // Add a conflict to trigger gate
    rejectingCoordinator.registerStage({
      id: 'conflict_stage',
      name: '冲突生成',
      role: 'writer',
      enableGate: true,
      executor: async () => '主角惨死于敌人手中'
    });

    await expect(rejectingCoordinator.runWorkflow({
      userPrompt: '测试冲突',
      stateLedger: {
        entities: [{ id: '1', name: '主角', status: 'alive' }],
        assets: [],
        tracks: [],
        locations: [],
        modifiedResources: []
      }
    })).rejects.toThrow(/门禁未通过/);
  });

  it('should test RoleRegistry, Typography options, and Storage Lanes helper branches', async () => {
    const { RoleRegistry } = await import('@inkpi/agent-core');
    const { formatChineseTypography, formatWesternTypography } = await import('@inkpi/editor-core');
    const { LaneManager, InkDb } = await import('@inkpi/storage');

    // RoleRegistry
    const reg = new RoleRegistry();
    expect(reg.getAll().length).toBeGreaterThan(0);
    expect(reg.has('writer')).toBe(true);
    expect(reg.has('non_existent')).toBe(false);

    // Typography
    expect(formatChineseTypography('段落文本', { enabled: false })).toBe('段落文本');
    expect(formatChineseTypography('段落文本', { indentString: '    ' })).toBe('    段落文本');
    expect(formatWesternTypography('  Hello   World  \n  Second   Line ')).toContain('Hello World');

    // Lanes
    const db = new InkDb(':memory:');
    db.prepare('INSERT INTO workspaces (id, title, owner, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('ws_1', 'test', 'user', 'novel', Date.now(), Date.now());
    const lanesMgr = new LaneManager(db);
    lanesMgr.createLane({ id: 'lane_1', workspaceId: 'ws_1', name: 'dev', description: '测试分支', isDefault: true, createdAt: Date.now(), updatedAt: Date.now() });
    expect(lanesMgr.getLanes('ws_1').length).toBe(1);
    lanesMgr.setDefaultLane('ws_1', 'lane_1');
  });

  it('should test StateLedger extraction: items/clue branches and XML tags', async () => {
    const { extractStateLedger } = await import('@inkpi/agent-core');

    // 触发 tool calls and standard tags
    const msgsWithItems = [
      {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'c1', name: 'update_entity', arguments: { name: 'Commander-Alpha', status: 'Active' } },
          { type: 'toolCall', id: 'c2', name: 'update_asset', arguments: { name: 'Quantum-Key', holder: 'Commander-Alpha' } },
          { type: 'text', text: '<entity name="Alice" status="Lead" /> <asset name="Keycard" holder="Alice" /> <track clue="Database-Access" status="pending" />' }
        ]
      } as any
    ];
    const ledger1 = extractStateLedger(msgsWithItems);
    expect(ledger1.entities.length).toBeGreaterThan(0);
    expect(ledger1.assets.length).toBeGreaterThan(0);
    expect(ledger1.tracks.length).toBeGreaterThan(0);

    // 触发 XML 标签 (location, track with content/status)
    const msgsXml = [
      { role: 'assistant', content: [{ type: 'text', text: '<location name="CommandCenter" /> <track content="ServerRoom" status="resolved" />' }] } as any
    ];
    const ledger2 = extractStateLedger(msgsXml);
    expect(ledger2.locations.length).toBeGreaterThan(0);
    expect(ledger2.tracks.some((t) => t.status === 'resolved')).toBe(true);

    // 触发 toolResult branch
    const msgsToolResult = [
      { role: 'toolResult', toolCallId: 't1', toolName: 'test', content: [{ type: 'text', text: '<track clue="AuditLog" status="pending" />' }] } as any
    ];
    const ledger3 = extractStateLedger(msgsToolResult);
    expect(ledger3).toBeDefined();
  });
});
