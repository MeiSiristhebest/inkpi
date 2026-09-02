# InkPi Technical Architecture Blueprint

This document details the architectural design, hexagonal ports & adapters topology, and domain model of **InkPi**. It is kept in sync with the code: the *Architectural invariants* and *Remediation status* sections below are enforced and verified by automated tests.

---

## 🏛️ 1. Hexagonal Ports & Adapters Architecture

InkPi separates domain logic from interface drivers and persistence adapters through **ports** (`ISessionBackend`, `AIProvider`).

> The topology below is now an accurate description of the code — verified by the
> dependency-direction ratchet, whose `BASELINE` is **empty** (see
> [§5 Remediation Status](#-5-remediation-status--known-debt) and
> [the ratchet](#the-dependency-direction-ratchet)). `@inkpi/agent-core` is a clean
> domain core: it no longer ships `src/tui/` or `src/rpc/`, and its only runtime
> dependencies are `@inkpi/protocol`, `@inkpi/ai`, and `@inkpi/editor-core`.
> `src/tui/` → `@inkpi/tui`; `src/rpc/` (daemon / server / transports) → `@inkpi/server`.

```text
    ┌──────────────────────────────────────────────────────────────────┐
    │                      External Client / UI Layer                  │
    │        Terminal TUI · Web Workspace · VS Code Extension          │
    │                                                                  │
    │  @inkpi/client · @inkpi/tui · JSON-RPC 2.0 Client                │
    └───────────────────────────┬──────────────────────────────────────┘
                                │ JSON-RPC 2.0 / TCP / WebSocket
                                ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │  @inkpi/server  (Transport / Runtime Adapter Layer)              │
    │                                                                  │
    │  InkPiDaemon · InkRpcServer · TCP/WS Transports · Client         │
    │  (LiveSessionManager re-exported from @inkpi/agent-core)         │
    └───────────────────────────┬──────────────────────────────────────┘
                                │ In-process typed dispatch (server → core)
                                ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │  @inkpi/agent-core  (Clean Domain Core — depends only on ports)  │
    │                                                                  │
    │  Agent · Agent Loop · SessionTree · WorkflowCoordinator           │
    │  ToolRegistry · ExtensionHost · MessageQueue · LiveSessionManager │
    │  ports: SessionStore · ModelStreamer · Clock · IdGenerator · …   │
    └──────────────┬───────────────────────────────┬───────────────────┘
                   │                               │
                   ▼ ISessionBackend Port          ▼ AIProvider Port
    ┌──────────────────────────────┐ ┌─────────────────────────────────┐
    │   @inkpi/session-backends    │ │          @inkpi/ai              │
    │  • MemorySessionBackend      │ │  • Provider registry            │
    │  • JsonlSessionBackend       │ │  • Model preset catalog         │
    │  • SqliteSessionBackend      │ │  • streamWithResilience         │
    └──────────────────────────────┘ └─────────────────────────────────┘
```

> **Daemon note:** the runtime daemon used by the CLI (`bin/inkpi.js`, `scripts/inkpi-standalone.mjs`) and the RPC/E2E tests now lives in `@inkpi/server` (`InkPiDaemon`). `@inkpi/agent-core` keeps the **domain object** `LiveSessionManager` (implements the `SessionStore` port; throws `NoModelConfiguredError` when neither an explicit nor default model is configured) and `@inkpi/server` re-exports it. The dependency is strictly one-way: `server → agent-core`. Both **require an explicit model** and fail loudly when none is configured (see invariants).

---

## 📦 2. 10-Package Decoupled Monorepo Structure

1. **`@inkpi/protocol`**: Pure domain schemas, TypeBox types, and JSON-RPC frames. Zero runtime dependencies.
2. **`@inkpi/session-backends`**: Pluggable storage backend adapters implementing the `ISessionBackend` contract with full LSP conformance (`id >= fromId` delta semantics across all backends).
3. **`@inkpi/server`**: Transport / runtime-adapter layer. Canonical home of the headless `InkPiDaemon`, the `InkRpcServer` (JSON-RPC 2.0 dispatch), the TCP/WebSocket transports, and the RPC client. Re-exports `LiveSessionManager` from `@inkpi/agent-core` (a domain object, not a transport concern). This package depends on `agent-core` + `storage` + `ws` — the dependency direction the review required (`server → core`, never the reverse).
4. **`@inkpi/client`**: Multi-transport client SDK (TCP Socket, WebSocket, In-Memory).
5. **`@inkpi/agent-core`**: Pure domain core — reasoning loop, message queues (`MessageQueue`), session/branch/tool/extension state machines, and the declared ports (`SessionStore`/`ModelStreamer`/`Clock`/`IdGenerator`/`Logger`/`FileSystem`). It depends only on `@inkpi/protocol`, `@inkpi/ai`, and `@inkpi/editor-core`; it no longer imports `@inkpi/tui`, `@inkpi/storage`, or `node:net`/`ws` (enforced by the dependency-direction ratchet, whose `BASELINE` is now empty).
6. **`@inkpi/editor-core`**: Headless editor state machine, ghost text completion, and Chinese typography engine.
7. **`@inkpi/storage`**: SQLite relational engine, FTS5 BM25 search, concurrency lanes, and writer leases.
8. **`@inkpi/tui`**: ANSI differential rendering pipeline, CJK width calculation, and terminal images.
9. **`@inkpi/ai`**: Multi-provider abstractions, model preset catalog, and stream reconnection. **Test doubles (`faux` provider, `mock-test` preset) are NOT registered on the production path** — see §3.
10. **`@inkpi/evals`**: Evaluation benchmarks and narrative consistency scoring.

---

## 🛡️ 3. Core Architectural Invariants

- **Strict Single Responsibility Principle (SRP)**: Pure state machines do not parse commands or handle RPC protocols.
- **Pluggable Session Storage via Ports & Adapters**: `ISessionBackend` allows swapping the *session* backend (Memory / Jsonl / Sqlite) without touching business logic. Note this covers the session store only — the relational layer underneath (`@inkpi/storage`) is still bound directly to `node:sqlite` and is **not** swappable.
- **Exact Version Pinning**: All dependencies are locked to exact versions without dynamic floating ranges.
- **Coverage Gate**: `vitest.config.ts` enforces $\ge 85\%$ lines, $\ge 85\%$ statements, $\ge 85\%$ functions, and $\ge 80\%$ branches. These are **aggregate** thresholds — `perFile` is not enabled, so local gaps are masked (current aggregate branch coverage is 80.46%, a margin of 19 branches).
- **No silent fake models (P0)**: A session with no configured model throws `NoModelConfiguredError`. The production `@inkpi/ai` registry does **not** include `mock-test`; that preset (and the `faux` provider) exist only behind the explicit `installTestDoubles()` test fixture.
- **Strict provider dispatch (P0)**: Unknown providers fail loudly (`Provider '…' is not registered`). `azure` / `bedrock` are explicitly unimplemented and throw `ProviderNotImplementedError` rather than being silently remapped to another transport.
- **Consistent delta semantics (LSP)**: `getDeltas(documentId, fromId)` returns deltas with `id >= fromId` (inclusive) on **every** backend (Memory / Jsonl / Sqlite). Timestamp-based compaction uses the separate `getDeltasSince` / `deleteDeltasBefore` APIs.
- **Pure reads**: `LiveSessionManager.getSession()` no longer mutates `lastActiveAt` as a side effect of a read.

These invariants are enforced by `tests/architecture-invariants.test.ts` (it re-imports `@inkpi/ai` / `@inkpi/agent-core` with a reset module registry so the *production*, test-doubles-not-installed state is asserted). If a future change reintroduces a silent fake or a silent "no model" path, this test fails in CI.

---

## 🧪 4. Architectural Guard Tests

| Invariant | Test |
| --- | --- |
| `mock-test` not registered by default in production | `production @inkpi/ai does NOT register the mock-test fixture by default` |
| Unknown provider fails loudly | `unknown providers fail loudly instead of silently mapping to a fake` |
| `azure`/`bedrock` throw | `unimplemented providers (azure/bedrock) throw instead of silent fallback` |
| No silent mock when model missing | `a session without a configured model fails loudly (no silent mock)` |
| Explicit test doubles install and respond | `explicit test doubles install cleanly and the mock-test path responds` |

Run with `node_modules/.bin/vitest run tests/architecture-invariants.test.ts`.

---

## 🔧 5. Remediation Status & Known Debt

This section records what changed so the documentation stays honest about the code. It is the durable companion to `ARCHITECTURE_REVIEW.md`.

### Fixed (code now matches the intended architecture)
- **Removed silent fake models.** `providers.ts` no longer maps unknown providers to `faux`, and `mock-test` was removed from the default `MODEL_PRESETS`. Both are now installed only via `installTestDoubles()` (test fixture). `tests/setup.ts` calls it once.
- **Loud model failure.** `LiveSessionManager.createSession()` throws `NoModelConfiguredError` when neither an explicit model nor a default model is available. `Agent` requires an explicit `initialState.model`.
- **LSP delta semantics.** `InkRepository.getDeltas` now filters `id >= afterId`; compactors use the new `getDeltasSince` / `deleteDeltasBefore` (timestamp-based) APIs, preserving compaction behavior.
- **Removed dead/over-engineered abstractions.** `SteeringQueue` / `FollowUpQueue` empty subclasses deleted (use `MessageQueue`); `WriterLeaseManager.acquireLease` / `releaseLease` aliases removed (use `acquire` / `release`).
- **XSS hardening.** Shared `escapeHtml` (covering `& < > " ' /`) now lives in `agent-core/src/export/html.ts` and is reused by all exporters.
- **Deterministic ports.** `InkPiDaemon.start()` records the OS-assigned port when binding to `0`; the E2E tests use dynamic ports instead of hard-coded ones.
- **Leaky getters removed.** `SqliteSessionBackend.getRepository()` / `getDb()` deleted; the conformance test no longer reaches into backend internals via `instanceof`.
- **Unified sandbox timeout.** Magic numbers (3000/2000/1000) collapsed into `DEFAULT_SANDBOX_TIMEOUT_MS`; invalid dice notation now throws `InvalidDiceNotationError` instead of returning a fake random value.
- **Domain ports declared (P2-8).** `packages/agent-core/src/ports/` now declares `SessionStore`, `ModelStreamer`, `Clock`, `IdGenerator`, `Logger`, and `FileSystem`. `LiveSessionManager implements SessionStore`; `AgentOptions.streamFn` is typed as `ModelStreamer`. `node:fs` is *not* re-exported from the package index, so the core public API stays free of the `node:` runtime.
- **Storage ports (P2-11).** `storage/src/ports.ts` defines `IDb` and `IRepository`; `InkDb implements IDb` and `InkRepository implements IRepository`, so the relational layer is finally swappable behind an interface.
- **`conformance` de-publicised and honest (P2-15).** `storage/src/conformance.ts` is deleted from the package; its suite lives in `tests/storage-conformance-suite.ts` as a self-test harness. `InkDb.checkpoint()` no longer swallows exceptions, so `verifyWalCheckpoint()` on a closed DB now correctly reports failure.
- **TUI parsers extracted (P3-17).** `parseMarkdown` / `parseMermaid` are now pure, ANSI-free functions under `packages/tui/src/parsers/`, with colocated unit tests; renderers consume the AST.
- **Unified `Clock` injection (P3-18).** `TelemetryCollector`, `LiveSessionManager`, `SessionCompactor`, and `runAgentLoop` now accept an injectable `Clock` (default `Date.now`), matching the already-injected `tree` / `branch-what-if`. `getStats()` / `getMetrics()` are pure reads and no longer end the turn.
- **Naming honesty (P3-19, partial).** `tree.fork()` removed (it only moved the pointer — callers now use `selectLeaf`); the `/branch` slash command no longer claims to have "forked a new branch". `SlashCommandRegistry.isSlashCommand` (which only checked the `/` prefix) is renamed to `isSlashSyntax`, and a real `hasCommand(name)` existence check is added. A full sweep of the 19 vague suffixes / 12 alias groups / remaining misnamed behaviours is **not yet done** (see Known Debt).
- **Package extraction — the single largest remaining item (P2-9 / P2-10), now done.** `src/rpc/` (daemon / server / client / transports) moved out of `@inkpi/agent-core` into `@inkpi/server`; `src/tui/` (studio / terminal-harness) moved into `@inkpi/tui`. `@inkpi/server` and `@inkpi/tui` already existed as stubs, so this was an *overwrite-the-stub-with-the-complete-version + clear-the-ratchet* operation, not a from-scratch package creation. `LiveSessionManager` — a domain object that implements the `SessionStore` port and throws `NoModelConfiguredError` when no model is configured — **stays in `agent-core`** and is re-exported by `@inkpi/server`, keeping `server → core` a clean one-way dependency. All external importers (`bin/inkpi.js`, `scripts/inkpi-standalone.mjs`, and 11 test files) were repointed to the new packages.
- **Core dependencies shrunk to ports-only.** `packages/agent-core/package.json` no longer declares `@inkpi/tui`, `@inkpi/storage`, or `ws`; it depends only on `@inkpi/protocol`, `@inkpi/ai`, `@inkpi/editor-core`. The circular project-reference graph (`tui ↔ agent-core ↔ server`) was broken by pruning `agent-core`'s stale `tui` / `server` / `storage` references.
- **Ratchet `BASELINE` cleared to `{}`.** With `agent-core` provably free of presentation/infrastructure/transport imports, the dependency-direction guard's `BASELINE` is now **empty** — any forbidden import fails CI immediately, and any *new* violation fails the build. The guard also asserts the scanner still detects violations via a synthetic sample, so an "always-green" regression cannot slip in.
- **RPC `withSession()` guard extracted (P2-14, partial).** The "get session / not-found throw" boilerplate repeated 9× across `InkPiDaemon`'s method handlers is now a single `withSession()` helper. The migrated `@inkpi/server` RPC layer already uses a `registerMethod()` registry (no 245-line `switch` in the transport package); the legacy `compatibilityMode` switch that remains lives in `WorkflowCoordinator` (see Known Debt).
- **TUI components reorganized by atomic design (P3-16).** `packages/tui/src/components/` is now `atoms/` (`Box` / `HStack` / `VStack` / `Spacer`), `molecules/` (`SelectList` / `ScrollView` / `ThinkingAccordion` / `Markdown`), `organisms/` (`Editor`), each with a barrel. The public API — including the `Box` / `HStack` / `VStack` / `Spacer` re-export aliases and `Editor` — is unchanged.
- **Giant classes incrementally decomposed (P2-12 / P2-13, partial).** The remaining "治本" item is now *started* with the lowest-risk first step — extract pure functions, then split methods — rather than blind class surgery:
  - `WorkflowCoordinator`: the duplicated gate-detection logic (`detectPlotGateIssues` vs the private `detectIssues`) collapsed into one pure `detectGateIssues()` in `pipeline/gate-detection.ts`; the complex ledger-merge logic extracted to `pipeline/ledger-merge.ts` (`mergeLedgers` / `mergeRecords`, both pure and now unit-tested). The coordinator class shed ~130 lines of duplicated/extractable logic.
  - `runAgentLoop`: the inline "walk content, collect tool calls" loop extracted to a pure `extractToolCalls()` (exported from `loop.ts`, unit-tested).
  - `TerminalStudio`: the constructor's label-default block extracted to a pure `buildDefaultStudioLabels()`; `renderScreen()` decomposed into `renderResourcePane` / `renderEditorPane` / `renderStatePane` / `applyModalOverlay` (output string is byte-identical, asserted by the existing `tui-studio.test.ts` substring checks).
  - All three preserve behaviour exactly (verified by `tsc -b` + the existing suite + new focused unit tests `pipeline-ledger-merge.test.ts` / `pipeline-gate-detection.test.ts` / `loop-extract-tool-calls.test.ts`). The *deeper* responsibility split into `StudioModel`/`StudioView`/`StudioController` or `StageRegistry`/`GateEvaluator`/`WorkflowExecutor` strategy classes is **still deferred** — it is lower-risk now that the risky logic is isolated, but remains optional and is tracked below.

### Scope of the remediation — read this before assuming things are fixed

The work completed so far covers **Phase 1 (stop the bleeding, 7/7 done)**, **most of
Phase 2**, and **most of Phase 3** of the roadmap in `ARCHITECTURE_REVIEW.md`:

- **Phase 2 done (6/8):** domain ports declared (#8), `storage` `IDb`/`IRepository` abstraction (#11), `conformance` de-publicised + honest `checkpoint` (#15), **package extraction (#9)**, **core deps removed (#10)**, **RPC `withSession()` helper (#14, partial)**.
- **Phase 2 started (2/8):** `TerminalStudio` M/VC split (#12), `WorkflowCoordinator`/`runAgentLoop` split (#13) — pure-function extraction + `renderScreen` method split done (see Fixed above); the deeper class/strategy decomposition is still deferred (see Known Debt).
- **Phase 3 done (4/6):** parsers extracted (#17), unified `Clock` injection (#18), docs synced (#21), **TUI atomic reorg (#16)**.
- **Phase 3 partial (1/6):** naming cleanup (#19) — `fork`→`selectLeaf`, telemetry pure-read, `isSlashSyntax`/`hasCommand` done; the bulk 19-suffix / 12-alias / remaining misnamed sweep is not done (aliases such as `TuiStudio` / `TerminalWriterHarness` are intentionally retained as public re-exports for backward compatibility).
- **Phase 3 blocked (1/6):** `perFile` coverage gate (#20) — cannot be measured in this sandbox (see Tooling below).

What this means concretely: **`@inkpi/agent-core` is now a genuine domain core.** It ships
no `src/tui/` and no `src/rpc/`; its only runtime dependencies are `@inkpi/protocol`,
`@inkpi/ai`, and `@inkpi/editor-core`; and the dependency-direction ratchet's `BASELINE`
is **empty**. The hexagonal topology drawn in §1 is now an **accurate description**, not an
aspiration. The remaining structural debt is confined to *within* the still-large classes
(`WorkflowCoordinator`, `TerminalStudio`, `runAgentLoop`) — behaviourally correct, but not
yet split along responsibility boundaries.

### Known debt (tracked, NOT yet resolved)

**Structural (Phase 2 — 6/8 done, 2/8 started)**
- **Giant classes: pure-function extraction done, deep split deferred.** `WorkflowCoordinator`, `TerminalStudio`, and `runAgentLoop` have each shed their duplicated/extractable logic into pure modules / helper methods (see Fixed above) — they are now smaller and the risky parts are unit-tested. What remains is the *responsibility* split into `StudioModel`/`StudioView`/`StudioController` (TerminalStudio), `StageRegistry`+`GateEvaluator`+`WorkflowExecutor` (WorkflowCoordinator), and `ContextTransformer`→`StreamInvoker`→`ToolDispatcher`→`TurnFinalizer` (runAgentLoop — the two tool-concurrency strategies in `loop.ts` / `tools.ts` must be merged into one). This deeper decomposition is deferred because it changes public shape and blind surgery risks the green suite; now that the risky logic is isolated it is lower-risk but still optional. Recommended incremental approach (verify `tsc -b` + targeted tests after each):
  - `WorkflowCoordinator` → `StageRegistry` + `GateEvaluator` (strategy) + `WorkflowExecutor` + `LedgerMerger` (pure, **already extracted**) + `TelemetryTracer`; collapse the 10× `compatibilityMode === 'legacy-pipeline'` branches into a `WorkflowStrategy` object.
  - `TerminalStudio` → `StudioModel` (domain + `subscribe()`, zero ANSI) + `StudioView` (pure `render(model)`, **`renderScreen` already split into pane methods**) + `StudioController` (`handleInput(key) → Command`).
  - `runAgentLoop` → `ContextTransformer` → `StreamInvoker` → `ToolDispatcher` → `TurnFinalizer` (**`extractToolCalls` already extracted**).
- **`TerminalStudio` has no ViewModel boundary** (domain state, view state, and rendering live in one class) — partially addressed by the `renderScreen` method split; full `StudioModel`/`StudioView`/`StudioController` separation remains.
- **`compatibilityMode` switch remains in `WorkflowCoordinator`** (sub-case of #13 above).

**Hardcoded / faked values (Phase 1 P1–P2 items, still present — carried from the review, NOT addressed in this remediation)**
- `journal.ts` writes a fabricated `'State ledger update'` row with `tokens_before/after` pinned to `0`, polluting any cost analytics built on `session_compaction_records`.
- `memory.ts` / `jsonl.ts` return `rank: -1` — a hardcoded fake BM25 score.
- `sqlite.ts` implicitly creates hardcoded `ws_default` / `folder_default` entities on any write.
- `telemetry.ts` hardcodes model pricing (`2.0` / `8.0` / `0.5` per M tokens) with no injection point.
- `telemetry.ts` emits `traceId: 'inkpi_trace_' + id`, which is not valid OTel (32 hex chars) and will be rejected by any backend.
- Token estimation uses a magic `0.7` chars-per-token factor in 8 places (`ai/prompt-caching.ts` ×4, `agent-core/compaction.ts` ×4) — used for *both* the trigger check and post-compaction accounting, so the error is self-confirming.
- `daemon.ts` still hardcodes the WS port as `TCP port + 1`; `127.0.0.1` appears in 8 places across `packages/*/src`.
- `reducer/session-reducer.ts` still mutates its argument in place, and only shallow-copies the `Map` — `OperationRecord` objects are shared with previous snapshots, which breaks replay.
- `session-share.ts` still uses `.filter()` with a mutation side effect.
- `tui` render methods still mutate component state (`components/editor.ts`, `components/scroll-view.ts`).

**Interface & naming (Phase 3 — partial)**
- `ISessionBackend.search?()` is still an optional member fake-ISP; `ExtensionAPI` is still a 17-method fat interface; 8 `[key: string]: unknown` index signatures remain in `protocol/src/extensions.ts`.
- **Done so far:** `tree.fork()` removed (use `selectLeaf`); `getStats()`/`getMetrics()` are pure reads; `SlashCommandRegistry.isSlashCommand` renamed to `isSlashSyntax` with a real `hasCommand()` check.
- **Not yet done:** 19 vague `Manager`/`Handler`/`Data` suffixes, and the remaining misnamed behaviours (`tree.branch()` does not branch; `package-manager.remove()` does not delete; `extension-host.getLoadedDocuments()` returns modules). The ~12 alias export groups (e.g. `NovelCollaborativePipeline`/`CollaborativePipeline`/`PipelineCoordinator`/`WorkflowCoordinator`, `AgentEngine`, `TuiStudio`, `TerminalWriterHarness`) are **intentionally retained** as public re-exports for backward compatibility and must not be deleted without a deprecation window.

**Tooling**
- **`tests/` is now in the TS project graph.** The prior "tests not type-checked" gap is closed — `tests/` is part of `tsc -b` and type errors there fail the build (this also retires the long-standing `tests/tui-harness.test.ts:59` typo).
- **`perFile: true` coverage is not enabled.** Aggregate branch coverage is 80.46% against an 80% threshold — a margin of 19 branches. The review's recommendation to gate per-file is still open.
- **`knip` is not installed.** The `@inkpi/*` global `ignoreDependencies` was removed from `knip.json` so future runs surface undeclared internal deps, but nothing runs it today.
- **`pnpm lint` reports pre-existing debt.** `biome.json` previously contained an invalid key (`includes` instead of `include`), which made Biome exit before checking anything — lint was silently a no-op. The config is now fixed and the formatter is aligned to the codebase's actual style (single quotes, no trailing commas), leaving 138 lint-rule violations and 136 formatting diffs accumulated over time. These were **deliberately not auto-fixed**: doing so would rewrite ~200 files and bury the architectural changes in formatting noise.

### The dependency-direction ratchet

`tests/dependency-direction.test.ts` implements the review's "add a check that can
fail" recommendation without turning CI red on day one:

- It scans `packages/agent-core/src/**/*.ts` for forbidden imports (`@inkpi/tui`, `@inkpi/storage`, `node:net`, `ws`).
- The `BASELINE` map is now **empty** — `agent-core` has zero forbidden imports, so CI is green *and* any forbidden import fails immediately.
- Any **new** violation fails the build immediately.
- The scanner also asserts it still detects a violation via a synthetic sample, so an "always-green" regression cannot slip in. Debt can only shrink, never grow.

`agent-core` is now a genuine domain core (empty `BASELINE` proves it).

---

## 🚀 6. Build, Test & Release

- **Build:** `pnpm build` → `tsc -b` (project references). `tests/` **is** part of the TS project graph, so test files are type-checked in CI.
- **Test:** `pnpm test` → `vitest run` (v8 coverage; aggregate gate 85% lines / 85% statements / 85% functions / 80% branches).
- **Coverage:** `pnpm test:coverage` → `vitest run --coverage`.
- **Lint:** `pnpm lint` → `biome check`. ⚠️ Reports pre-existing debt (138 lint-rule violations + 136 formatting diffs). The config was previously invalid (`includes` instead of `include`), which made lint a silent no-op; it is now valid but not yet clean. Clear it as a standalone commit with `pnpm format` plus a reviewed `biome check --write`.
- **Standalone binary:** `scripts/inkpi-standalone.mjs` is the dev/test entrypoint; it installs test doubles explicitly so headless integration tests can run without real API keys.
