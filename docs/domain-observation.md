# Observing a domain projection

Both RPC clients expose `watchDomain(workspaceId, options)`. The async iterator
first yields a validated `snapshot`. Requesting the next item starts a revision
page read. Writes committed while the snapshot was being delivered are therefore
read after that snapshot; the client must apply each yielded item before asking
for the next one.

The iterator pulls on demand. A slow consumer has no growing push queue and does
not cause audit entries to be discarded. Each `changes` item is contiguous and
contains at most `pageSize` change sets (100 by default, maximum 1000). Server
pages have a conservative 1 MiB bound; SQLite checks stored byte lengths before
loading payloads. An individual record exceeding that bound is rejected by the
page API and remains in the source log. The existing initial and reset snapshots
contain the full log and are not reduced to that page bound.

Domain snapshots and page cursors carry a host-generated history `epoch`.
Appending changes retains it; restoring a snapshot replaces it. A purge removes
the cursor. Old page cursors then cause a `reset` item containing a fresh
snapshot, even if an earlier portion of history changed while its last record
and revision remained the same. An empty workspace can adopt its first epoch at
revision zero. Storage schema 3 migrates old cursor rows and preserves epoch
through process restart. Snapshot capture and page reads use database
transactions so cursor and log observations are consistent.

`return()` closes the observation and cancels an outstanding read wait or polling
timer. `signal` supports caller cancellation. Empty pages are polled every 250 ms
by default while a `next()` call is outstanding. Lost, repeated, foreign-workspace
or out-of-order changes are rejected before publication. Reconnecting requires a
new iterator, which begins with a fresh snapshot. Task events retain their
separate delivery and durable admission contracts.

The page method is opt-in through the `domain.sync.page` capability; existing
snapshot and pull methods remain available. Legacy explicit undefined deletion
payloads that disappear during JSON serialization are restored only when the
historical checksum matches. Tests use both clients against a real TCP daemon and
exercise snapshot delivery races, slow consumption, history replacement,
cancellation, byte limits and an actual SQLite schema upgrade and reopen.
