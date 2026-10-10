# @inkpi/server

> Headless Daemon, Multi-Session Lifecycle, and JSON-RPC 2.0 Server for InkPi

This package provides the server-side runtime for InkPi:

1. **`InkPiDaemon`**: Background daemon listening on TCP sockets or IPC pipes, routing multi-session RPC calls.
2. **`SessionRegistry`**: Concurrent session lifecycle manager (`createSession`, `getSession`, `closeSession`, `listSessions`; formerly `LiveSessionManager`).
3. **`InkRpcServer`**: JSON-RPC 2.0 dispatching engine.

## Usage

```typescript
import { InkPiDaemon, SessionRegistry } from '@inkpi/server';
import { MemorySessionBackend } from '@inkpi/session-backends';

const sessionManager = new SessionRegistry(() => new MemorySessionBackend());
const daemon = new InkPiDaemon({ port: 9876, sessionManager });
await daemon.start();
console.log('InkPi Daemon listening on port 9876');
```

## Session connections

Create a session before attaching a client connection to it. Each attachment is scoped to one
server process, session instance, and connection. Switching sessions aborts local waits tied to
the previous attachment; close and recreate a session to invalidate its prior route. Session
notifications are delivered only to connections attached to the matching session instance.

```typescript
import { InkRpcClient } from '@inkpi/server';

const client = await InkRpcClient.connectTcp(9876);
const { sessionId } = await client.request<{ sessionId: string }>('session.create', { model: 'mock-test' });
await client.attachSession(sessionId);
const state = await client.getSessionState();
```

The JSON-RPC TCP and WebSocket transports default to an 8 MiB frame limit, a 16 MiB queued-send
limit, 256 pending requests, and a 30 second request or blocked-send deadline. The server and
client constructors accept partial `RpcLimits` overrides. Closing a client cancels its response
waiters; it does not cancel a task after the server has accepted it.
