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
