# State ownership and replay

Session reducers treat a materialized snapshot as owned, read-only state. New
message content, operation payloads, frames and state patches are copied at
admission. Untouched message and operation records may be shared between
snapshots. The generic state adapter shares unchanged state branches and copies
new patches. Custom adapters receive a copy of the prior state and patch so they
can mutate those inputs without changing an earlier snapshot. Adapter results
transfer ownership to the reducer.

These snapshots are not deeply frozen at runtime. Code that exposes them to a
mutable external consumer must copy them; callers of pure reducer APIs must not
mutate prior snapshots. The existing full `reduceSession` boundary copies an
external initial snapshot. JSON log replay does not use a connection path
dictionary; workspace IDs and revision checks keep projections separate.

Domain projection payloads must pass the protocol's strict JSON validation before
they are persisted. Values such as non-finite numbers, dates, maps, sparse arrays,
symbol keys and nested `undefined` are rejected rather than converted by
`JSON.stringify`. Deletion retains the historical optional top-level
`payload: undefined` representation so existing checksums remain readable.

The storage encoding uses a version 2 envelope containing changes and indices of
explicit undefined deletion payloads. No payload object is interpreted as an
encoding marker. Legacy array logs, including the former undefined marker, remain
readable. New logs, projection rebuilds and checksum backfill use the same codec.

`tests/state-replay-properties.test.ts` compares seeded session operation sequences
with full replay and randomized restart cuts. It also compares randomized domain
array moves, deletions and aggregate removal with an independent model across two
workspaces and snapshot restores, and mutates admitted inputs and returned
projections to check ownership. The tests preserve document and SourceMap domain
structures rather than introducing a generic patch format.
