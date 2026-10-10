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

## Journal contract (version 1)

`appendEntry` and `loadEntries` use `appendEntries`, which validates the complete batch before writing. Entries must belong to the target session, have unique IDs and strictly increasing positive sequences, and reference an earlier parent or a null root. Import preserves IDs, sequence gaps, timestamps, hashes, lane/operation IDs and payload metadata. Omitted entry versions normalize to 1; unsupported versions are rejected. Returned histories and pages do not expose stored objects.

Memory adopts the validated batch in one synchronous operation. JSONL commits one record, using `{ "journalBatch": 1, "entries": [...] }` for multiple entries; legacy individual entry records remain readable. A torn final batch exposes none of its entries. Complete malformed records, invalid placement and unsupported batch versions fail explicitly. Writes flush the file with `fsync`; an unknown write/flush outcome blocks subsequent writes to that session until a new backend reconstructs the journal. Incomplete tails are preserved and require explicit repair before appending.

JSONL snapshots are written to a new file, flushed, then renamed over the old snapshot. Rename failure retains the previous snapshot. These operations support process-crash recovery; they do not establish a portable power-loss guarantee for directory entries or filesystem/device caches. JSONL requires one writer per directory; it does not provide a cross-process lease.

SQLite validates and writes each batch in a database transaction. Storage schema 2 scopes the entry key to `(session_id, id)` and preserves hashes so forks cannot overwrite the source. Schema upgrades, data backfills and the version marker commit in one transaction; failure rolls them all back. Future schema versions are refused. SQLite durability follows the configured SQLite journal/synchronous settings; this contract does not enable a new durability pragma. An in-memory SQLite database reports `durableDisk: false`.

`getEntryPage(sessionId, { limit, direction, cursor })` returns up to 1,000 entries ordered by sequence, ascending for `forward` and descending for `backward`. The first page fixes an inclusive upper sequence boundary. A cursor retains that boundary, direction and session, so appends between pages cannot duplicate, omit or introduce entries in the traversal. Timestamps are independent of page order. JSONL and Memory currently scan their history for each page; pagination bounds returned data, not storage read cost.

`forkSession(source, target)` copies the full journal into an empty target with a new session ID. Passing a head ID copies only its ancestor path; passing null copies an empty path. All other IDs and payload references remain unchanged. This is a storage copy: product session forks must separately replace provider affinity identities, as `SessionRegistry.forkSession` does. Memory and JSONL search use keyword matching and report `fts: false`; SQLite supplies FTS search.

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
