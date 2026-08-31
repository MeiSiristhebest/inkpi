import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'node:net';
import {
  InkRpcServer,
  InkRpcClient,
  MemoryTransport,
  RemoteStreamTransport,
  TcpSocketTransport,
  WebSocketRpcTransport
} from '@meisiristhebest/agent-core';
import { HeadlessEditorState } from '@meisiristhebest/editor-core';

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

  it('should support WebSocketRpcTransport interface', () => {
    const nodeListeners: Record<string, any> = {};
    let sentData = '';
    const mockWs = {
      send: (data: string) => { sentData = data; },
      on: (event: string, cb: any) => { nodeListeners[event] = cb; },
      close: () => {}
    };
    const wsTransport = new WebSocketRpcTransport(mockWs);
    let receivedMsg = '';
    wsTransport.onMessage((msg) => { receivedMsg = msg; });
    expect(wsTransport.isOpen()).toBe(true);
    wsTransport.send('{"test":true}');
    expect(sentData).toBe('{"test":true}');

    nodeListeners['message']?.(Buffer.from('{"jsonrpc":"2.0"}'));
    expect(receivedMsg).toBe('{"jsonrpc":"2.0"}');

    nodeListeners['error']?.(new Error('err'));
    nodeListeners['close']?.();
    expect(wsTransport.isOpen()).toBe(false);

    // Send when closed
    wsTransport.send('{"ignore":true}');

    // Browser addEventListener variant
    const domListeners: Record<string, any> = {};
    const mockDomWs = {
      send: () => {},
      addEventListener: (evt: string, cb: any) => { domListeners[evt] = cb; },
      close: () => {}
    };
    const domTransport = new WebSocketRpcTransport(mockDomWs);
    let domReceived = '';
    domTransport.onMessage((msg) => { domReceived = msg; });
    domListeners['message']?.({ data: '{"jsonrpc":"2.0"}' });
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
