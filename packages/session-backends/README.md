# @inkpi/session-backends

> Pluggable Session Storage Backends for InkPi (1:1 Inspired by Pi Architecture)

This package defines the unified `ISessionBackend` port contract and provides three pluggable, LSP-compliant adapters:

1. **`MemorySessionBackend`**: Pure in-memory Map storage with zero I/O for deterministic testing and stateless API gateways.
2. **`JsonlSessionBackend`**: Pure append-only JSONL files with zero C++ native bindings for lightweight CLI and cross-platform deployment.
3. **`SqliteSessionBackend`**: Full ACID SQLite relational storage with FTS5 BM25 search, snapshot compaction, and concurrency leases.

## Usage

```typescript
import {
  MemorySessionBackend,
  JsonlSessionBackend,
  SqliteSessionBackend
} from '@inkpi/session-backends';

const backend = new MemorySessionBackend();
await backend.initialize();
await backend.appendEntry('sess_1', {
  id: 'e1',
  sessionId: 'sess_1',
  seq: 1,
  parentId: null,
  type: 'user_message',
  timestamp: Date.now(),
  payload: { content: 'Once upon a time...' }
});
```
