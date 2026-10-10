import type * as net from 'node:net';
import { Agent } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import {
  InkRpcClient as ClientInkRpcClient,
  MemoryTransport as ClientMemoryTransport,
  RemoteStreamTransport as ClientRemoteStreamTransport
} from '@inkpi/client';
import { HeadlessEditorState } from '@inkpi/editor-core';
import type { AgentMessage, ImageContent } from '@inkpi/protocol';
import {
  InkRpcClient,
  InkRpcServer,
  MemoryTransport,
  RemoteStreamTransport,
  TcpSocketTransport,
  WebSocketRpcTransport
} from '@inkpi/server';
import { AppendOnlySessionJournal } from '@inkpi/storage';
import { afterEach, describe, expect, it } from 'vitest';

describe('InkPi RPC Remote Transports & Server/Client', () => {
  let server: InkRpcServer | null = null;

  afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
  });

  it('should communicate bidirectionally via MemoryTransport', async () => {
    const editor = new HeadlessEditorState();
    editor.insert('最初的灵感片段');
    server = new InkRpcServer({ editor });

    const [tServer, tClient] = MemoryTransport.createPair();
    server.bindTransport(tServer);

    const clientTransport = new RemoteStreamTransport(tClient);
    const client = new InkRpcClient(clientTransport);

    const res = await client.getEditorText();
    const text = typeof res === 'string' ? res : res.text;
    expect(text).toBe('最初的灵感片段');

    await client.insertEditorText('\n第二段设定');
    const updated = await client.getEditorText();
    const updatedText = typeof updated === 'string' ? updated : updated.text;
    expect(updatedText).toBe('最初的灵感片段\n第二段设定');
  });

  it('rejects pending RPC calls when the remote transport closes', async () => {
    const [tServer, tClient] = MemoryTransport.createPair();
    const clientTransport = new RemoteStreamTransport(tClient);
    const pending = clientTransport.sendRequest({ jsonrpc: '2.0', id: 1, method: 'test' });

    tServer.close();

    await expect(pending).rejects.toThrow('RPC memory connection closed');
    await expect(clientTransport.sendRequest({ jsonrpc: '2.0', id: 2, method: 'test' })).rejects.toThrow(
      'RPC transport is closed'
    );
  });

  it('client package rejects pending RPC calls when the remote transport closes', async () => {
    const [tServer, tClient] = ClientMemoryTransport.createPair();
    const clientTransport = new ClientRemoteStreamTransport(tClient);
    const pending = clientTransport.sendRequest({ jsonrpc: '2.0', id: 1, method: 'test' });

    tServer.close();

    await expect(pending).rejects.toThrow('RPC memory connection closed');
  });

  it('preserves inline image content across client RPC, agent state, and session journal', async () => {
    const prompt = 'Describe the attached image.';
    const image: ImageContent = { type: 'image', image: 'AQID', mimeType: 'image/png' };
    const modelInputs: AgentMessage[][] = [];
    let nextJournalId = 0;
    const journal = new AppendOnlySessionJournal({
      sessionId: 'image-session',
      idGenerator: () => `image-event-${++nextJournalId}`,
      clock: () => 1234
    });
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') },
      journal,
      clock: () => 1234,
      streamFn: (_model, messages) => {
        modelInputs.push(messages);
        const stream = new AssistantEventStream();
        stream.push({ type: 'text_delta', textDelta: 'received' });
        stream.end();
        return stream;
      }
    });
    server = new InkRpcServer({ agent });

    const [tServer, tClient] = MemoryTransport.createPair();
    server.bindTransport(tServer);
    const client = new ClientInkRpcClient(new ClientRemoteStreamTransport(tClient));

    await client.prompt(prompt, [image]);

    const messageId = agent.state.messages[0]?.id;
    expect(messageId).toEqual(expect.any(String));
    const expectedUserMessage = {
      id: messageId,
      role: 'user',
      content: [{ type: 'text', text: prompt }, image],
      timestamp: 1234
    };
    expect(agent.state.messages.find((message) => message.role === 'user')).toEqual(expectedUserMessage);
    expect(modelInputs[0]?.find((message) => message.role === 'user')).toEqual(expectedUserMessage);

    const persisted = journal.getEntriesByType('user_message');
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.id).toBe(messageId);
    const { id: _messageId, ...journalPayload } = expectedUserMessage;
    expect(persisted[0]?.payload).toEqual(journalPayload);

    const restoredJournal = new AppendOnlySessionJournal({ sessionId: 'image-session' });
    restoredJournal.importFromJsonl(journal.exportToJsonl());
    expect(restoredJournal.getEntriesByType('user_message')[0]).toMatchObject({
      id: messageId,
      payload: journalPayload
    });
  });

  it('removes a pending RPC call when sending fails', async () => {
    const transport = {
      send: () => {
        throw new Error('send failed');
      },
      onMessage: () => {},
      close: () => {},
      isOpen: () => true
    };
    const clientTransport = new RemoteStreamTransport(transport);

    await expect(clientTransport.sendRequest({ jsonrpc: '2.0', id: 1, method: 'test' })).rejects.toThrow('send failed');
    await expect(clientTransport.sendRequest({ jsonrpc: '2.0', id: 1, method: 'test' })).rejects.toThrow('send failed');
  });

  it('should support WebSocketRpcTransport interface', async () => {
    const nodeListeners: Record<string, any> = {};
    let sentData = '';
    const mockWs = {
      send: (data: string) => {
        sentData = data;
      },
      on: (event: string, cb: any) => {
        nodeListeners[event] = cb;
      },
      close: () => {}
    };
    const wsTransport = new WebSocketRpcTransport(mockWs);
    let receivedMsg = '';
    wsTransport.onMessage((msg) => {
      receivedMsg = msg;
    });
    expect(wsTransport.isOpen()).toBe(true);
    wsTransport.send('{"test":true}');
    expect(sentData).toBe('{"test":true}');

    nodeListeners.message?.(Buffer.from('{"jsonrpc":"2.0"}'));
    expect(receivedMsg).toBe('{"jsonrpc":"2.0"}');

    nodeListeners.error?.(new Error('err'));
    nodeListeners.close?.();
    expect(wsTransport.isOpen()).toBe(false);

    // Send when closed
    await expect(wsTransport.send('{"ignore":true}')).rejects.toThrow(/closed|err/);

    // Browser addEventListener variant
    const domListeners: Record<string, any> = {};
    const mockDomWs = {
      send: () => {},
      addEventListener: (evt: string, cb: any) => {
        domListeners[evt] = cb;
      },
      close: () => {}
    };
    const domTransport = new WebSocketRpcTransport(mockDomWs);
    let domReceived = '';
    domTransport.onMessage((msg) => {
      domReceived = msg;
    });
    domListeners.message?.({ data: '{"jsonrpc":"2.0"}' });
    expect(domReceived).toBe('{"jsonrpc":"2.0"}');
    domTransport.close();
    expect(domTransport.isOpen()).toBe(false);
  });

  it('should communicate over native TCP socket transport', async () => {
    const editor = new HeadlessEditorState();
    editor.insert('TCP 传输测试正文');
    server = new InkRpcServer({ editor });

    const netServer = await server.listenTcp(0);
    const port = (netServer.address() as net.AddressInfo).port;

    const client = await InkRpcClient.connectTcp(port);
    const res = await client.getEditorText();
    const text = typeof res === 'string' ? res : res.text;
    expect(text).toBe('TCP 传输测试正文');

    await client.insertEditorText('\n通过 TCP 远程追加内容');
    const updated = await client.getEditorText();
    const updatedText = typeof updated === 'string' ? updated : updated.text;
    expect(updatedText).toBe('TCP 传输测试正文\n通过 TCP 远程追加内容');
  });
});
