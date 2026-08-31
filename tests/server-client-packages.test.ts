import { describe, it, expect, afterAll } from 'vitest';
import {
  InkPiDaemon,
  LiveSessionManager,
  InkRpcServer
} from '@inkpi/server';
import {
  InkRpcClient,
  MemoryTransport,
  WebSocketTransport,
  InMemoryTransport,
  RemoteStreamTransport
} from '@inkpi/client';
import { MemorySessionBackend } from '@inkpi/session-backends';

describe('Comprehensive @inkpi/server & @inkpi/client Test Suite', () => {
  const testPort = 19892;
  let daemon: InkPiDaemon;
  let client: InkRpcClient;

  afterAll(async () => {
    if (client) await client.close();
    if (daemon) await daemon.stop();
  });

  it('should cover MemoryTransport and WebSocketTransport lifecycle', async () => {
    // 1. MemoryTransport
    const [t1, t2] = MemoryTransport.createPair();
    expect(t1.isOpen()).toBe(true);
    expect(t2.isOpen()).toBe(true);

    const received: string[] = [];
    t2.onMessage((msg) => received.push(msg));
    t1.send('hello memory');

    await new Promise((res) => setTimeout(res, 20));
    expect(received).toContain('hello memory');

    t1.close();
    expect(t1.isOpen()).toBe(false);
    expect(t2.isOpen()).toBe(false);

    // 2. WebSocketTransport mock
    const mockWsListeners = new Map<string, Array<Function>>();
    const mockWs = {
      readyState: 1,
      send: (data: string) => {
        const listeners = mockWsListeners.get('message') || [];
        for (const l of listeners) l({ data: `echo:${data}` });
      },
      close: () => {
        mockWs.readyState = 3;
        const listeners = mockWsListeners.get('close') || [];
        for (const l of listeners) l();
      },
      addEventListener: (type: string, listener: Function) => {
        if (!mockWsListeners.has(type)) mockWsListeners.set(type, []);
        mockWsListeners.get(type)!.push(listener);
      }
    };

    const wsTransport = new WebSocketTransport(mockWs as any);
    expect(wsTransport.isOpen()).toBe(true);

    const wsMsgs: string[] = [];
    wsTransport.onMessage((m) => wsMsgs.push(m));
    wsTransport.send('ping');
    expect(wsMsgs).toContain('echo:ping');

    wsTransport.close();
    expect(wsTransport.isOpen()).toBe(false);
  });

  it('should cover InkRpcServer and InMemoryTransport', async () => {
    const server = new InkRpcServer();
    server.registerMethod('math.add', (params: { a: number; b: number }) => params.a + params.b);

    const transport = new InMemoryTransport(server);
    const client = new InkRpcClient(transport);

    const sum = await client.request<number>('math.add', { a: 10, b: 20 });
    expect(sum).toBe(30);

    // Unknown method error
    await expect(client.request('math.unknown')).rejects.toThrow(/Method 'math.unknown' not found/);

    // Notifications
    const notifs: any[] = [];
    client.onNotification((n) => notifs.push(n));
    server.notify('system.alert', { msg: 'test' });
    expect(notifs.length).toBe(1);

    await server.close();
  });

  it('should cover all InkRpcClient high-level methods via RemoteStreamTransport and Daemon', async () => {
    const sessionManager = new LiveSessionManager(() => new MemorySessionBackend());
    daemon = new InkPiDaemon({ port: testPort, sessionManager });
    await daemon.start();

    client = await InkRpcClient.connectTcp(testPort);

    // Session creation & listing
    const createRes = await client.request<{ sessionId: string; createdAt: number }>('session.create', {
      sessionId: 'sess_e2e_all',
      initialText: '初始文本内容。'
    });
    expect(createRes.sessionId).toBe('sess_e2e_all');

    const sessions = await client.request<any[]>('session.list');
    expect(sessions.length).toBe(1);

    // Prompt & Notifications
    const events: any[] = [];
    const unsub = client.on('session.event', (data) => events.push(data));

    const promptRes = await client.request<any>('session.prompt', {
      sessionId: 'sess_e2e_all',
      prompt: '请续写一段。'
    });
    expect(promptRes.success).toBe(true);
    expect(promptRes.messageCount).toBe(2);

    // Editor operations
    const insertRes = await client.request<any>('session.editor.insert', {
      sessionId: 'sess_e2e_all',
      pos: 4,
      text: '【精彩剧情】'
    });
    expect(insertRes.text).toContain('【精彩剧情】');

    const undoRes = await client.request<any>('session.editor.undo', {
      sessionId: 'sess_e2e_all'
    });
    expect(undoRes.success).toBe(true);

    const redoRes = await client.request<any>('session.editor.redo', {
      sessionId: 'sess_e2e_all'
    });
    expect(redoRes.success).toBe(true);

    // Ghost text suggest & accept & dismiss
    await client.request('session.ghost.suggest', {
      sessionId: 'sess_e2e_all',
      text: '第一句建议。第二句建议。'
    });
    const acceptWord = await client.request<any>('session.ghost.accept', {
      sessionId: 'sess_e2e_all',
      mode: 'word'
    });
    expect(acceptWord.accepted).toBe(true);

    const acceptLine = await client.request<any>('session.ghost.accept', {
      sessionId: 'sess_e2e_all',
      mode: 'line'
    });
    expect(acceptLine.accepted).toBe(true);

    const dismissRes = await client.request<any>('session.ghost.dismiss', {
      sessionId: 'sess_e2e_all'
    });
    expect(dismissRes.success).toBe(true);

    // Abort
    const abortRes = await client.request<any>('session.abort', {
      sessionId: 'sess_e2e_all'
    });
    expect(abortRes.success).toBe(true);

    // Client typed helpers using mock server
    const typedServer = new InkRpcServer();
    typedServer.registerMethod('agent.prompt', (p: any) => ({ success: true, turnId: 't1', messages: [] }));
    typedServer.registerMethod('agent.steer', (p: any) => ({ success: true }));
    typedServer.registerMethod('agent.abort', () => ({ success: true }));
    typedServer.registerMethod('session.getState', () => ({ messages: [], branches: [] }));
    typedServer.registerMethod('command.execute', (p: any) => ({ output: 'cmd done' }));
    typedServer.registerMethod('editor.insert', (p: any) => 'inserted');
    typedServer.registerMethod('editor.delete', (p: any) => 'deleted');
    typedServer.registerMethod('editor.undo', () => ({ success: true, text: '' }));
    typedServer.registerMethod('editor.redo', () => ({ success: true, text: '' }));
    typedServer.registerMethod('ghost.suggest', (p: any) => ({ success: true, ghostText: p.text }));
    typedServer.registerMethod('ghost.accept', (p: any) => ({ success: true, acceptedText: 'ok', mode: p.mode }));
    typedServer.registerMethod('ghost.dismiss', () => ({ success: true }));
    typedServer.registerMethod('storage.queryMemory', () => []);
    typedServer.registerMethod('storage.searchFts', () => []);
    typedServer.registerMethod('pipeline.run', () => ({ success: true, result: {} }));
    typedServer.registerMethod('telemetry.getMetrics', () => ({ ttftMs: 10 }));
    typedServer.registerMethod('telemetry.exportOtel', () => '{}');

    const typedClient = new InkRpcClient(new InMemoryTransport(typedServer));
    await expect(typedClient.prompt('test')).resolves.toBeDefined();
    await expect(typedClient.steer('steer')).resolves.toBeDefined();
    await expect(typedClient.abort()).resolves.toBeDefined();
    await expect(typedClient.getSessionState()).resolves.toBeDefined();
    await expect(typedClient.executeCommand('/test', '')).resolves.toBeDefined();
    await expect(typedClient.editorInsert(0, 'a')).resolves.toBe('inserted');
    await expect(typedClient.editorDelete(0, 1)).resolves.toBe('deleted');
    await expect(typedClient.editorUndo()).resolves.toBeDefined();
    await expect(typedClient.editorRedo()).resolves.toBeDefined();
    await expect(typedClient.suggestGhostText('ghost')).resolves.toBeDefined();
    await expect(typedClient.acceptGhostText('word')).resolves.toBeDefined();
    await expect(typedClient.dismissGhostText()).resolves.toBeDefined();
    await expect(typedClient.queryMemory('q')).resolves.toBeDefined();
    await expect(typedClient.searchFts('q')).resolves.toBeDefined();
    await expect(typedClient.triggerWorkflow('w')).resolves.toBeDefined();
    await expect(typedClient.getTelemetry()).resolves.toBeDefined();
    await expect(typedClient.exportOpenTelemetry()).resolves.toBe('{}');

    unsub();
    await client.request('session.close', { sessionId: 'sess_e2e_all' });
  });
});
