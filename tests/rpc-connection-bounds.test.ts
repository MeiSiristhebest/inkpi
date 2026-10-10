import { EventEmitter } from 'node:events';
import type * as net from 'node:net';
import {
  RpcBufferedSender,
  RpcLineBuffer,
  type RpcNotification,
  RpcSendWindow,
  RpcStreamRequests,
  type RpcWireTransport,
  resolveRpcLimits
} from '@inkpi/protocol';
import { InkRpcServer, TcpSocketTransport, WebSocketRpcTransport } from '@inkpi/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

describe('bounded RPC connection lifetimes', () => {
  it('counts UTF-8 bytes across fragments and resets each completed frame', () => {
    const limits = resolveRpcLimits({ maxFrameBytes: 8, maxQueuedBytes: 8 });
    const frames = new RpcLineBuffer(limits);
    expect(frames.push('你')).toEqual([]);
    expect(frames.push('好\n')).toEqual(['你好']);
    expect(() => frames.push('123456789')).toThrow(/byte limit/);
    expect(frames.push('ok\n')).toEqual(['ok']);
  });

  it('bounds the combined owned and native send backlog', () => {
    const limits = resolveRpcLimits({ maxFrameBytes: 6, maxQueuedBytes: 6 });
    const window = new RpcSendWindow(limits);
    const release = window.reserve('abc', 2);
    expect(() => window.reserve('1234', 2)).toThrow(/queue exceeds/);
    release();
    expect(() => window.reserve('12345', Number.NaN)).not.toThrow();
  });

  it('flushes blocked websocket sends and rejects them at the deadline', async () => {
    vi.useFakeTimers();
    const limits = resolveRpcLimits({ maxFrameBytes: 8, maxQueuedBytes: 8, requestTimeoutMs: 20 });
    let bufferedAmount = 4;
    const failures: Error[] = [];
    const sent: string[] = [];
    const sender = new RpcBufferedSender(
      limits,
      () => bufferedAmount,
      (message) => {
        sent.push(message);
      },
      (error) => {
        failures.push(error);
        sender.close(error);
      }
    );
    const pending = sender.send('data');
    await vi.advanceTimersByTimeAsync(10);
    bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(10);
    await expect(pending).resolves.toBeUndefined();
    expect(sent).toEqual(['data']);

    bufferedAmount = 4;
    const stuck = sender.send('wait');
    const rejected = expect(stuck).rejects.toThrow('RPC WebSocket send timed out');
    await vi.advanceTimersByTimeAsync(20);
    await rejected;
    expect(failures).toHaveLength(1);
  });

  it('isolates caller IDs across cancel, timeout, and late replies', async () => {
    vi.useFakeTimers();
    let onMessage!: (message: string) => void;
    const sent: string[] = [];
    const raw: RpcWireTransport = {
      send: (message) => {
        sent.push(message);
      },
      onMessage: (handler) => {
        onMessage = handler;
      },
      close: () => {},
      isOpen: () => true
    };
    const transport = new RpcStreamRequests(raw, { requestTimeoutMs: 15 });
    const request = { jsonrpc: '2.0' as const, id: 7, method: 'test' };
    const cancel = new AbortController();
    const cancelled = transport.sendRequest(request, { signal: cancel.signal });
    const firstWire = JSON.parse(sent[0]!).id as string;
    const cancelledCheck = expect(cancelled).rejects.toThrow('cancelled');
    cancel.abort(new Error('cancelled'));
    await cancelledCheck;

    const next = transport.sendRequest(request);
    const secondWire = JSON.parse(sent[1]!).id as string;
    expect(secondWire).not.toBe(firstWire);
    onMessage(JSON.stringify({ jsonrpc: '2.0', id: firstWire, result: 'late' }));
    onMessage(JSON.stringify({ jsonrpc: '2.0', id: secondWire, result: 'current' }));
    await expect(next).resolves.toMatchObject({ id: 7, result: 'current' });

    const timedOut = transport.sendRequest({ ...request, id: 8 });
    const timeoutCheck = expect(timedOut).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(15);
    await timeoutCheck;
    const reused = transport.sendRequest({ ...request, id: 8 });
    expect(sent).toHaveLength(4);
    const reusedCheck = expect(reused).rejects.toThrow('closed while awaiting');
    await transport.close();
    await reusedCheck;
  });

  it('caps outstanding calls and closes the stream on a malformed response', async () => {
    let onMessage!: (message: string) => void;
    const sent: string[] = [];
    const raw: RpcWireTransport = {
      send: (message) => {
        sent.push(message);
      },
      onMessage: (handler) => {
        onMessage = handler;
      },
      close: () => {},
      isOpen: () => true
    };
    const transport = new RpcStreamRequests(raw, { maxPendingRequests: 1 });
    const pending = transport.sendRequest({ jsonrpc: '2.0', id: 'one', method: 'test' });
    await expect(transport.sendRequest({ jsonrpc: '2.0', id: 'two', method: 'test' })).rejects.toThrow('limit reached');
    const disconnected = expect(pending).rejects.toThrow('Invalid RPC response');
    onMessage('{"jsonrpc":"2.0","id":42,"result":"wrong wire id type"}');
    await disconnected;
    await expect(transport.sendRequest({ jsonrpc: '2.0', id: 'three', method: 'test' })).rejects.toThrow('closed');
    expect(sent).toHaveLength(1);
  });

  it('drains every close listener, isolates notification consumers, and awaits raw close', async () => {
    let closeRaw!: () => void;
    let onMessage!: (message: string) => void;
    const closeGate = new Promise<void>((resolve) => {
      closeRaw = resolve;
    });
    const raw: RpcWireTransport = {
      send: () => {},
      onMessage: (handler) => {
        onMessage = handler;
      },
      onClose: (handler) => {
        rawClose = handler;
      },
      close: async () => closeGate,
      isOpen: () => true
    };
    let rawClose!: (error?: Error) => void;
    const transport = new RpcStreamRequests(raw);
    let drained = false;
    transport.onClose(() => {
      throw new Error('listener');
    });
    transport.onClose(() => {
      drained = true;
    });
    const observed: string[] = [];
    transport.onNotification(() => {
      throw new Error('consumer');
    });
    transport.onNotification((notification: RpcNotification) => observed.push(notification.method));
    onMessage(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: {} }));
    expect(observed).toEqual(['event']);
    const closed = transport.close();
    let finished = false;
    void closed.then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(finished).toBe(false);
    closeRaw();
    rawClose(new Error('closed'));
    await closed;
    expect(finished).toBe(true);
    expect(drained).toBe(true);
  });

  it('closes a real TCP peer that sends an oversized partial frame', async () => {
    const server = new InkRpcServer({}, undefined, { maxFrameBytes: 128, maxQueuedBytes: 256 });
    const listener = await server.listenTcp(0, '127.0.0.1');
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const socket = await import('node:net').then(
      ({ createConnection }) =>
        new Promise<import('node:net').Socket>((resolve, reject) => {
          const connection = createConnection({ host: '127.0.0.1', port: address.port }, () => resolve(connection));
          connection.once('error', reject);
        })
    );
    try {
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.write('x'.repeat(129));
      await closed;
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      await server.close();
    }
  });

  it('rejects queued TCP writes together when the native backlog exceeds its limit', async () => {
    vi.useFakeTimers();
    class MockSocket extends EventEmitter {
      destroyed = false;
      writableLength = 0;
      writes: string[] = [];
      callbacks: Array<(error?: Error | null) => void> = [];
      setEncoding(): void {}
      write(data: string, callback: (error?: Error | null) => void): boolean {
        this.writes.push(data);
        this.writableLength += Buffer.byteLength(data);
        this.callbacks.push(callback);
        return false;
      }
      destroy(): this {
        this.destroyed = true;
        this.emit('close');
        return this;
      }
    }
    const socket = new MockSocket();
    const transport = new TcpSocketTransport(socket as unknown as net.Socket, {
      maxFrameBytes: 8,
      maxQueuedBytes: 8,
      requestTimeoutMs: 20
    });
    const first = transport.send('abc');
    const second = transport.send('123');
    const firstCheck = expect(first).rejects.toThrow(/queue exceeds/);
    const secondCheck = expect(second).rejects.toThrow(/queue exceeds/);
    await expect(transport.send('x')).rejects.toThrow(/queue exceeds/);
    await Promise.all([firstCheck, secondCheck]);
    expect(socket.destroyed).toBe(true);
    expect(socket.writes).toHaveLength(2);
  });

  it('closes and rejects WebSocket sends when the native backlog is full', async () => {
    vi.useFakeTimers();
    const handlers = new Map<string, (...args: any[]) => void>();
    const sent: string[] = [];
    let bufferedAmount = 5;
    let closed = false;
    const ws = {
      readyState: 1,
      get bufferedAmount() {
        return bufferedAmount;
      },
      send: (message: string) => {
        sent.push(message);
      },
      close: () => {
        closed = true;
        handlers.get('close')?.();
      },
      on: (event: string, handler: (...args: any[]) => void) => {
        handlers.set(event, handler);
      }
    };
    const transport = new WebSocketRpcTransport(ws, {
      maxFrameBytes: 8,
      maxQueuedBytes: 8,
      requestTimeoutMs: 20
    });
    const pending = transport.send('abc');
    const pendingCheck = expect(pending).rejects.toThrow(/queue exceeds/);
    await expect(transport.send('1234')).rejects.toThrow(/queue exceeds/);
    await pendingCheck;
    expect(closed).toBe(true);
    expect(sent).toEqual(['abc']);
    bufferedAmount = 0;
  });
});
