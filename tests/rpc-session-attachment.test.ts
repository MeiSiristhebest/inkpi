import { RpcSessionAttachment, type SessionAttachment } from '@inkpi/protocol';
import { InMemoryTransport, InkRpcClient, InkRpcServer } from '@inkpi/server';
import { afterEach, describe, expect, it } from 'vitest';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}
function nextSessionEvent(client: InkRpcClient): Promise<unknown> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    unsubscribe = client.on('session.event', (event) => {
      unsubscribe();
      resolve(event);
    });
  });
}

describe('session attachment routing over TCP', () => {
  let server: InkRpcServer | undefined;
  let clients: InkRpcClient[] = [];
  afterEach(async () => {
    await Promise.all(clients.map((client) => client.close()));
    clients = [];
    await server?.close();
    server = undefined;
  });

  it('routes per connection and invalidates retired objects and old notifications', async () => {
    const sessions = new Map<string, { marker: string }>([
      ['alpha', { marker: 'A' }],
      ['beta', { marker: 'B' }]
    ]);
    server = new InkRpcServer();
    server.configureSessionRouting((sessionId) => sessions.get(sessionId));
    server.registerMethod('session.value', ({ sessionId }: { sessionId: string }) => sessions.get(sessionId)?.marker);
    const listener = await server.listenTcp(0, '127.0.0.1');
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    clients = await Promise.all([
      InkRpcClient.connectTcp(address.port, '127.0.0.1'),
      InkRpcClient.connectTcp(address.port, '127.0.0.1')
    ]);
    const [first, second] = clients;
    const firstRoute = await first!.attachSession('alpha');
    const secondRoute = await second!.attachSession('alpha');
    expect(firstRoute).not.toEqual(secondRoute);
    expect(await first!.request('session.value')).toBe('A');
    await expect(first!.request('session.value', { sessionId: 'beta' })).rejects.toThrow('targets another session');

    const firstEvents: unknown[] = [];
    const secondEvent = nextSessionEvent(second!);
    const offFirst = first!.on('session.event', (event) => firstEvents.push(event));
    server.notifySessionEvent('alpha', sessions.get('alpha')!, { value: 1 });
    await expect(secondEvent).resolves.toMatchObject({ event: { value: 1 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(firstEvents).toHaveLength(1);

    const stillAlpha = nextSessionEvent(second!);
    await first!.attachSession('beta');
    server.notifySessionEvent('alpha', sessions.get('alpha')!, { value: 2 });
    await expect(stillAlpha).resolves.toMatchObject({ event: { value: 2 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(firstEvents).toHaveLength(1);
    offFirst();

    const retiredAlpha = sessions.get('alpha')!;
    sessions.set('alpha', { marker: 'A2' });
    await expect(second!.request('session.value')).rejects.toThrow('stale');
    const nextRoute = await second!.attachSession('alpha');
    expect(nextRoute.sessionEpoch).not.toBe(secondRoute.sessionEpoch);
    const noRetiredEvent = nextSessionEvent(second!);
    server.notifySessionEvent('alpha', retiredAlpha, { value: 3 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondRoute.attachmentId).not.toBe(nextRoute.attachmentId);
    // The old session object is no longer a source; the next event must come from the replacement.
    server.notifySessionEvent('alpha', sessions.get('alpha')!, { value: 4 });
    await expect(noRetiredEvent).resolves.toMatchObject({ event: { value: 4 } });
  });

  it('keeps accepted work running after the requesting TCP client disconnects', async () => {
    const started = deferred();
    const finish = deferred();
    let completed = false;
    server = new InkRpcServer();
    server.registerMethod('task.accepted', async () => {
      started.resolve();
      await finish.promise;
      completed = true;
      return { completed: true };
    });
    const listener = await server.listenTcp(0, '127.0.0.1');
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');
    const client = await InkRpcClient.connectTcp(address.port, '127.0.0.1');
    clients.push(client);
    const accepted = client.request('task.accepted');
    await started.promise;
    const rejected = expect(accepted).rejects.toThrow(/closed/);
    await client.close();
    await rejected;
    finish.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(completed).toBe(true);
  });

  it('keeps direct in-memory client routes and notifications separate', async () => {
    const alpha = { marker: 'A' };
    const beta = { marker: 'B' };
    server = new InkRpcServer();
    server.configureSessionRouting((id) => ({ alpha, beta })[id as 'alpha' | 'beta']);
    server.registerMethod(
      'session.value',
      ({ sessionId }: { sessionId: 'alpha' | 'beta' }) => ({ alpha, beta })[sessionId].marker
    );
    const first = new InkRpcClient(new InMemoryTransport(server));
    const second = new InkRpcClient(new InMemoryTransport(server));
    const unscoped = new InkRpcClient(new InMemoryTransport(server));
    clients = [first, second, unscoped];
    await first.attachSession('alpha');
    await second.attachSession('beta');
    let leakedEventCount = 0;
    unscoped.on('session.event', () => {
      leakedEventCount++;
    });
    const genericEvent = new Promise<void>((resolve) => {
      let remaining = 2;
      first.on('task.event', () => {
        if (--remaining === 0) resolve();
      });
      second.on('task.event', () => {
        if (--remaining === 0) resolve();
      });
    });
    server.notify('task.event', { taskId: 'shared-task' });
    await genericEvent;
    expect(await first.request('session.value')).toBe('A');
    expect(await second.request('session.value')).toBe('B');
    const alphaEvent = nextSessionEvent(first);
    server.notifySessionEvent('alpha', alpha, { value: 5 });
    await expect(alphaEvent).resolves.toMatchObject({ event: { value: 5 } });
    expect(leakedEventCount).toBe(0);
  });

  it('discards an attach result after a newer selection starts', () => {
    const state = new RpcSessionAttachment();
    const first = state.beginAttach();
    const second = state.beginAttach();
    expect(first.signal.aborted).toBe(true);
    const route: SessionAttachment = {
      serverId: 'server',
      sessionId: 'beta',
      sessionEpoch: 'epoch',
      attachmentId: 'attachment'
    };
    expect(state.accept(second.generation, 'beta', route)).toEqual(route);
    expect(() => state.accept(first.generation, 'alpha', { ...route, sessionId: 'alpha' })).toThrow(/superseded/);
    expect(state.forRequest('session.getState', {}).route).toEqual(route);
  });

  it('rejects a response carrying an older route', async () => {
    const route: SessionAttachment = {
      serverId: 'server',
      sessionId: 'alpha',
      sessionEpoch: 'epoch',
      attachmentId: 'current'
    };
    let sequence = 0;
    const client = new InkRpcClient({
      sendRequest: async (request) => {
        sequence++;
        return request.method === 'session.attach'
          ? { jsonrpc: '2.0', id: request.id, result: route }
          : { jsonrpc: '2.0', id: request.id, result: {}, route: { ...route, attachmentId: 'old' } };
      },
      onNotification: () => () => {}
    });
    await client.attachSession('alpha');
    await expect(client.request('session.getState')).rejects.toThrow('another session attachment');
    expect(sequence).toBe(2);
    await client.close();
  });

  it('rejects an attachment copied to a restarted server', async () => {
    const session = { marker: 'A' };
    const prior = new InkRpcServer();
    prior.configureSessionRouting(() => session);
    const oldRoute: SessionAttachment = await prior
      .handleRequest(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'session.attach',
          params: { sessionId: 'alpha' }
        },
        'old-connection'
      )
      .then((response) => response.result as SessionAttachment);
    server = new InkRpcServer();
    server.configureSessionRouting(() => session);
    const response = await server.handleRequest(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'session.value',
        params: { sessionId: 'alpha' },
        route: oldRoute
      },
      'new-connection'
    );
    expect(response.error?.message).toMatch(/stale/);
  });
});
