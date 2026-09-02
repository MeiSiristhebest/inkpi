import { InkPiDaemon, InkRpcClient } from '@inkpi/server';
import { afterAll, describe, expect, it } from 'vitest';

describe('InkPi Daemon & Multi-Session RPC 2.0 (1:1 Ported from pi-server)', () => {
  const daemon = new InkPiDaemon({ host: '127.0.0.1' });
  let client: InkRpcClient;

  afterAll(async () => {
    if (client) {
      await client.close();
    }
    await daemon.stop();
  });

  it('should start daemon and respond to daemon.status and session management RPCs', async () => {
    // Bind to port 0 so the OS assigns a free port (no hard-coded port collisions).
    await daemon.start(0);
    const statusBefore = daemon.getStatus();
    expect(statusBefore.running).toBe(true);
    const assignedPort = statusBefore.port;
    expect(assignedPort).toBeGreaterThan(0);

    // Connect RPC Client using the OS-assigned port
    client = await InkRpcClient.connectTcp(assignedPort!, '127.0.0.1');

    // 1. Check daemon status over RPC
    const statusRpc = await client.request<any>('daemon.status');
    expect(statusRpc.running).toBe(true);
    expect(statusRpc.activeSessions).toBe(0);

    // 2. Create session
    const createRes = await client.request<any>('session.create', {
      sessionId: 'sess_novel_1',
      initialText: '第一章：浩瀚星海。',
      model: 'mock-test'
    });
    expect(createRes.sessionId).toBe('sess_novel_1');

    // 3. List sessions
    const listRes = await client.request<any[]>('session.list');
    expect(listRes.length).toBe(1);
    expect(listRes[0].sessionId).toBe('sess_novel_1');
    expect(listRes[0].documentLength).toBeGreaterThan(0);

    // 4. Test editor operations over RPC
    const insertRes = await client.request<any>('session.editor.insert', {
      sessionId: 'sess_novel_1',
      pos: 9,
      text: '战舰引擎轰鸣。'
    });
    expect(insertRes.text).toBe('第一章：浩瀚星海。战舰引擎轰鸣。');

    const undoRes = await client.request<any>('session.editor.undo', {
      sessionId: 'sess_novel_1'
    });
    expect(undoRes.success).toBe(true);
    expect(undoRes.text).toBe('第一章：浩瀚星海。');

    const redoRes = await client.request<any>('session.editor.redo', {
      sessionId: 'sess_novel_1'
    });
    expect(redoRes.success).toBe(true);
    expect(redoRes.text).toBe('第一章：浩瀚星海。战舰引擎轰鸣。');

    // 5. Test ghost text suggestions over RPC
    const ghostRes = await client.request<any>('session.ghost.suggest', {
      sessionId: 'sess_novel_1',
      text: '幽灵文本建议第一行\n第二行'
    });
    expect(ghostRes.text).toContain('幽灵文本建议');

    // Accept word
    const acceptWordRes = await client.request<any>('session.ghost.accept', {
      sessionId: 'sess_novel_1',
      mode: 'word'
    });
    expect(acceptWordRes.accepted).toBe(true);

    // Accept line
    const acceptLineRes = await client.request<any>('session.ghost.accept', {
      sessionId: 'sess_novel_1',
      mode: 'line'
    });
    expect(acceptLineRes.accepted).toBe(true);

    // Dismiss remainder
    const dismissRes = await client.request<any>('session.ghost.dismiss', {
      sessionId: 'sess_novel_1'
    });
    expect(dismissRes.success).toBe(true);

    // 6. Get session state
    const stateRes = await client.request<any>('session.get_state', {
      sessionId: 'sess_novel_1'
    });
    expect(stateRes.sessionId).toBe('sess_novel_1');
    expect(stateRes.editorText).toBeDefined();

    // 7. Prompt agent over session RPC and capture streaming notification
    const events: any[] = [];
    client.onNotification((notif) => {
      if (notif.method === 'session.event') {
        events.push(notif.params);
      }
    });

    const promptRes = await client.request<any>('session.prompt', {
      sessionId: 'sess_novel_1',
      prompt: '续写一段壮烈的情节'
    });
    expect(promptRes.success).toBe(true);
    expect(promptRes.messageCount).toBeGreaterThan(0);
    expect(events.length).toBeGreaterThan(0);

    // 8. Test session.abort and ghost.accept with mode 'all'
    const createRes2 = await client.request<any>('session.create', { sessionId: 'sess_novel_2', model: 'mock-test' });
    expect(createRes2.sessionId).toBe('sess_novel_2');

    await client.request('session.ghost.suggest', { sessionId: 'sess_novel_2', text: '全部采纳内容' });
    const acceptAllRes = await client.request<any>('session.ghost.accept', { sessionId: 'sess_novel_2' });
    expect(acceptAllRes.accepted).toBe(true);

    const abortRes = await client.request<any>('session.abort', { sessionId: 'sess_novel_2' });
    expect(abortRes.success).toBe(true);

    // 9. Close session
    const closeRes = await client.request<any>('session.close', {
      sessionId: 'sess_novel_1'
    });
    expect(closeRes.success).toBe(true);

    const closeRes2 = await client.request<any>('session.close', {
      sessionId: 'sess_novel_2'
    });
    expect(closeRes2.success).toBe(true);

    // Close non-existent
    const closeMissing = await client.request<any>('session.close', {
      sessionId: 'non_existent_close'
    });
    expect(closeMissing.success).toBe(false);

    const listAfterClose = await client.request<any[]>('session.list');
    expect(listAfterClose.length).toBe(0);

    // 10. Error handling for missing session
    await expect(client.request('session.get_state', { sessionId: 'non_existent' })).rejects.toThrow(/not found/);

    await expect(client.request('session.prompt', { sessionId: 'non_existent', prompt: 'hi' })).rejects.toThrow(
      /not found/
    );

    await expect(client.request('session.abort', { sessionId: 'non_existent' })).rejects.toThrow(/not found/);

    await expect(
      client.request('session.editor.insert', { sessionId: 'non_existent', pos: 0, text: 'a' })
    ).rejects.toThrow(/not found/);

    await expect(client.request('session.editor.undo', { sessionId: 'non_existent' })).rejects.toThrow(/not found/);

    await expect(client.request('session.editor.redo', { sessionId: 'non_existent' })).rejects.toThrow(/not found/);

    await expect(client.request('session.ghost.suggest', { sessionId: 'non_existent', text: 'a' })).rejects.toThrow(
      /not found/
    );

    await expect(client.request('session.ghost.accept', { sessionId: 'non_existent' })).rejects.toThrow(/not found/);

    await expect(client.request('session.ghost.dismiss', { sessionId: 'non_existent' })).rejects.toThrow(/not found/);

    // Direct SessionRegistry helper coverage
    const sm = daemon.getSessionManager();
    const sOrCreate = sm.getOrCreateSession('sess_created', { model: 'mock-test' });
    expect(sOrCreate.sessionId).toBe('sess_created');
    const sGet = sm.getOrCreateSession('sess_created');
    expect(sGet.sessionId).toBe('sess_created');

    // Idempotent start()
    const sameDaemon = await daemon.start();
    expect(sameDaemon).toBe(daemon);
  });
});
