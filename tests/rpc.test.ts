import { Agent, SessionTree } from '@inkpi/agent-core';
import { getModelPreset } from '@inkpi/ai';
import { GhostTextManager, HeadlessEditorState } from '@inkpi/editor-core';
import { InMemoryTransport, InkRpcClient, InkRpcServer } from '@inkpi/server';
import { FtsSearchEngine, InkDb, InkRepository } from '@inkpi/storage';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core -> JSON-RPC 2.0 Client & Server Headless Protocol', () => {
  it('should dispatch full writer pipeline via RPC client and receive streaming notifications', async () => {
    const db = new InkDb(':memory:');
    const repo = new InkRepository(db);
    const fts = new FtsSearchEngine(db);

    const agent = new Agent({
      initialState: {
        model: getModelPreset('mock-test')
      }
    });
    const tree = new SessionTree();
    const editor = new HeadlessEditorState();
    const ghost = new GhostTextManager(editor);

    const server = new InkRpcServer({
      agent,
      tree,
      editor,
      ghost,
      storage: repo,
      fts
    });

    const transport = new InMemoryTransport(server);
    const client = new InkRpcClient(transport);

    // 1. Subscribe to push notifications
    const receivedEvents: any[] = [];
    const unsubscribe = client.on('agent.event', (event) => {
      receivedEvents.push(event);
    });

    // 2. Insert text via RPC
    const editRes = await client.insertEditorText(0, '夜深了，烛火微微摇曳。');
    expect(editRes.text).toBe('夜深了，烛火微微摇曳。');

    // 3. Set and Accept Ghost Text via RPC
    await client.setGhostText(editRes.text.length, '窗外忽然传来一声异响。');
    const ghostAcceptRes = await client.acceptGhostText();
    expect(ghostAcceptRes.accepted).toBe(true);
    expect(ghostAcceptRes.text).toContain('窗外忽然传来一声异响');

    // 4. Prompt agent via RPC
    await client.prompt('请描写异响的来源。');
    expect(receivedEvents.length).toBeGreaterThan(0);
    expect(receivedEvents.some((e) => e.type === 'agent_end')).toBe(true);

    // 5. Execute slash command via RPC
    const slashRes = await client.executeSlashCommand('/help');
    expect(slashRes.handled).toBe(true);
    expect(slashRes.output).toContain('InkPi 指令清单');

    // 6. Test Tree branches, fork & switch via RPC
    const rootNodeId = tree.addMessage({ role: 'user', content: '初始设定' } as any);
    const branchesBefore = await client.getBranches();
    expect(Array.isArray(branchesBefore)).toBe(true);

    const forkRes = await client.call<any>('tree.fork', { fromNodeId: rootNodeId });
    expect(forkRes.leafId).toBe(rootNodeId);
    expect(forkRes.node.id).toBe(rootNodeId);

    const switchRes = await client.switchBranch(forkRes.leafId);
    expect(switchRes.currentLeafId).toBe(forkRes.leafId);

    // 7. Test Editor getText & FTS
    const text = await client.getEditorText();
    expect(text).toContain('夜深了');

    const ftsRes = await client.searchFts('烛火');
    expect(Array.isArray(ftsRes)).toBe(true);

    // 8. Test Agent abort & getState
    await client.abort();
    const state = await client.call<any>('agent.getState');
    expect(state.model).toBeDefined();

    unsubscribe();
    db.close();
  });

  it('should handle RPC errors for unknown methods or invalid requests', async () => {
    const server = new InkRpcServer();
    const transport = new InMemoryTransport(server);
    const client = new InkRpcClient(transport);

    // Unknown method
    await expect(client.call('non_existent_method')).rejects.toThrow();

    // Invalid JSON-RPC request
    const invalidRes = await server.handleRequest({} as any);
    expect(invalidRes.error).toBeDefined();

    // Uninitialized components throwing friendly errors
    await expect(client.call('agent.prompt', { prompt: 'hi' })).rejects.toThrow('Agent not initialized');
    await expect(client.call('agent.abort')).rejects.toThrow('Agent not initialized');
    await expect(client.call('tree.switchBranch', { targetLeafId: 'leaf_1' })).rejects.toThrow(
      'SessionTree not initialized'
    );
    await expect(client.call('tree.fork', {})).rejects.toThrow('SessionTree not initialized');
    await expect(client.call('editor.insertText', { pos: 0, text: 'a' })).rejects.toThrow('Editor not initialized');
    await expect(client.call('ghost.set', { pos: 0, text: 'b' })).rejects.toThrow('Ghost text manager not initialized');
    await expect(client.call('ghost.accept')).rejects.toThrow('Ghost text manager not initialized');

    // Unconfigured capabilities must be reported explicitly; an empty result
    // is reserved for an initialized capability with no matching data.
    await expect(client.call('tree.getBranches')).rejects.toThrow('SessionTree not initialized');
    await expect(client.call('editor.getText')).rejects.toThrow('Editor not initialized');
    await expect(client.call('storage.searchFts', { query: 'test' })).rejects.toThrow(
      'FTS search capability not initialized'
    );
  });
});
