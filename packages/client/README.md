# @meisiristhebest/client

> Type-Safe Client SDK and Multi-Transport Protocol Client for InkPi

This package provides the client SDK for connecting to InkPi daemon or in-process instances:

1. **`InkRpcClient`**: Type-safe RPC SDK with helper methods for sessions, editors, ghost text, and workflows.
2. **`TcpSocketTransport`**: Native TCP streaming with newline framing.
3. **`WebSocketTransport`**: Standard WebSocket transport for web, VS Code extension, or Tauri frontend.
4. **`MemoryTransport`**: Direct in-memory paired transport for zero-overhead local integration.

## Usage

```typescript
import { InkRpcClient } from '@meisiristhebest/client';

// Connect via TCP
const client = await InkRpcClient.connectTcp(9876);

// Create session and insert text
await client.request('session.create', { sessionId: 'my_story' });
await client.editorInsert(0, '# Chapter 1: The Awakening\n');
```
