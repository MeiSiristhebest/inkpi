# @inkpi/session-backends

> Pluggable Session Storage Backends for InkPi (1:1 Inspired by Pi Architecture)

This package defines the unified `ISessionBackend` port contract and provides three pluggable, LSP-compliant adapters:

1. **`MemorySessionBackend`**: Pure in-memory Map storage with zero I/O for deterministic testing and stateless API gateways.
2. **`JsonlSessionBackend`**: Pure append-only JSONL files with zero C++ native bindings for lightweight CLI and cross-platform deployment.
3. **`SqliteSessionBackend`**: Full ACID SQLite relational storage with FTS5 BM25 search, snapshot compaction, and concurrency leases.

## JSONL Recovery

- Reads reject malformed newline-terminated records in a session or delta journal. An invalid final record without a newline is treated as an interrupted append and ignored.
- Appends refuse to write after an incomplete final record. A valid final record without a newline is delimited before the next append.
- Snapshot reads and writes reject invalid JSON or a non-object root. A write does not replace a corrupt snapshot file.

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
