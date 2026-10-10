# @inkpi/client

> Type-Safe Client SDK and Multi-Transport Protocol Client for InkPi

This package provides the client SDK for connecting to InkPi daemon or in-process instances:

1. **`InkRpcClient`**: Type-safe RPC SDK with helper methods for sessions, editors, ghost text, and workflows.
2. **`TcpSocketTransport`**: Native TCP streaming with newline framing.
3. **`WebSocketTransport`**: Standard WebSocket transport for web, VS Code extension, or Tauri frontend.
4. **`MemoryTransport`**: Direct in-memory paired transport for zero-overhead local integration.

## Usage

```typescript
import { InkRpcClient } from '@inkpi/client';

// Connect via TCP
const client = await InkRpcClient.connectTcp(9876);

// Create and attach this connection to a session
const { sessionId } = await client.request<{ sessionId: string }>('session.create', { sessionId: 'my_story' });
await client.attachSession(sessionId);
await client.request('session.editor.insert', { pos: 0, text: '# Chapter 1: The Awakening\n' });
```

`attachSession` is also available on `@inkpi/server`'s `InkRpcClient`. Attachments identify the
server process, session instance, and connection. Switching the attachment cancels local request
waits for the previous session. Session RPC responses and `session.event` notifications carry the
attachment route; SDK clients discard stale replies and events. General task RPCs remain independent
of session attachment and are not cancelled when a client disconnects.

## Image prompts

`client.prompt(text, images)` sends image content inline in the `agent.prompt` JSON-RPC request. Each image is an `ImageContent` object with an `image` value containing base64 data or a URL and an optional `mimeType`. The server keeps the image block in the user message and in the session journal when one is configured. The protocol has no separate image upload or attachment ID; callers that need an external attachment ID must keep it in their own state.
