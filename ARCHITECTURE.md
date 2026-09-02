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
    │  (SessionRegistry re-exported from @inkpi/agent-core)             │
    └───────────────────────────┬──────────────────────────────────────┘
                                │ In-process typed dispatch (server → core)
                                ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │  @inkpi/agent-core  (Clean Domain Core — depends only on ports)  │
    │                                                                  │
    │  Agent · Agent Loop · SessionTree · WorkflowCoordinator           │
    │  ToolRegistry · ExtensionHost · MessageQueue · SessionRegistry    │
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

> **Daemon note:** the runtime daemon used by the CLI (`bin/inkpi.js`, `scripts/inkpi-standalone.mjs`) and the RPC/E2E tests now lives in `@inkpi/server` (`InkPiDaemon`). `@inkpi/agent-core` keeps the **domain object** `SessionRegistry` (implements the `SessionStore` port; throws `NoModelConfiguredError` when neither an explicit nor default model is configured; the old name `LiveSessionManager` survives as a `@deprecated` alias in `src/deprecations.ts`) and `@inkpi/server` re-exports it. The dependency is strictly one-way: `server → agent-core`. Both **require an explicit model** and fail loudly when none is configured (see invariants).

---

## 📦 2. 10-Package Decoupled Monorepo Structure

1. **`@inkpi/protocol`**: Pure domain schemas, TypeBox types, and JSON-RPC frames. Zero runtime dependencies.
2. **`@inkpi/session-backends`**: Pluggable storage backend adapters implementing the `ISessionBackend` contract with full LSP conformance (`id >= fromId` delta semantics across all backends).
3. **`@inkpi/server`**: Transport / runtime-adapter layer. Canonical home of the headless `InkPiDaemon`, the `InkRpcServer` (JSON-RPC 2.0 dispatch), the TCP/WebSocket transports, and the RPC client. Re-exports `SessionRegistry` from `@inkpi/agent-core` (a domain object, not a transport concern). This package depends on `agent-core` + `storage` + `ws` — the dependency direction the review required (`server → core`, never the reverse).
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
- **Coverage Gate**: `vitest.config.ts` enforces $\ge 85\%$ lines, $\ge 85\%$ statements, $\ge 85\%$ functions, and $\ge 80\%$ branches. These are **aggregate** thresholds — `perFile` is not enabled, so local gaps are masked (current aggregate: 91.52% lines/stmts, 94.63% funcs, 81.11% branch — branch margin ~1.1 points).
- **No silent fake models (P0)**: A session with no configured model throws `NoModelConfiguredError`. The production `@inkpi/ai` registry does **not** include `mock-test`; that preset (and the `faux` provider) exist only behind the explicit `installTestDoubles()` test fixture.
- **Strict provider dispatch (P0)**: Unknown providers fail loudly (`Provider '…' is not registered`). `azure` / `bedrock` are explicitly unimplemented and throw `ProviderNotImplementedError` rather than being silently remapped to another transport.
- **Consistent delta semantics (LSP)**: `getDeltas(documentId, fromId)` returns deltas with `id >= fromId` (inclusive) on **every** backend (Memory / Jsonl / Sqlite). Timestamp-based compaction uses the separate `getDeltasSince` / `deleteDeltasBefore` APIs.
- **Pure reads**: `SessionRegistry.getSession()` no longer mutates `lastActiveAt` as a side effect of a read.

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
- **Loud model failure.** `SessionRegistry.createSession()` throws `NoModelConfiguredError` when neither an explicit model nor a default model is available. `Agent` requires an explicit `initialState.model`.
- **LSP delta semantics.** `InkRepository.getDeltas` now filters `id >= afterId`; compactors use the new `getDeltasSince` / `deleteDeltasBefore` (timestamp-based) APIs, preserving compaction behavior.
- **Removed dead/over-engineered abstractions.** `SteeringQueue` / `FollowUpQueue` empty subclasses deleted (use `MessageQueue`); `WriterLeaseManager.acquireLease` / `releaseLease` aliases removed (use `acquire` / `release`).
- **XSS hardening.** Shared `escapeHtml` (covering `& < > " ' /`) now lives in `agent-core/src/export/html.ts` and is reused by all exporters.
- **Deterministic ports.** `InkPiDaemon.start()` records the OS-assigned port when binding to `0`; the E2E tests use dynamic ports instead of hard-coded ones.
- **Leaky getters removed.** `SqliteSessionBackend.getRepository()` / `getDb()` deleted; the conformance test no longer reaches into backend internals via `instanceof`.
- **Unified sandbox timeout.** Magic numbers (3000/2000/1000) collapsed into `DEFAULT_SANDBOX_TIMEOUT_MS`; invalid dice notation now throws `InvalidDiceNotationError` instead of returning a fake random value.
- **Domain ports declared (P2-8).** `packages/agent-core/src/ports/` now declares `SessionStore`, `ModelStreamer`, `Clock`, `IdGenerator`, `Logger`, and `FileSystem`. `SessionRegistry implements SessionStore`; `AgentOptions.streamFn` is typed as `ModelStreamer`. `node:fs` is *not* re-exported from the package index, so the core public API stays free of the `node:` runtime.
- **Storage ports (P2-11).** `storage/src/ports.ts` defines `IDb` and `IRepository`; `InkDb implements IDb` and `InkRepository implements IRepository`, so the relational layer is finally swappable behind an interface.
- **`conformance` de-publicised and honest (P2-15).** `storage/src/conformance.ts` is deleted from the package; its suite lives in `tests/storage-conformance-suite.ts` as a self-test harness. `InkDb.checkpoint()` no longer swallows exceptions, so `verifyWalCheckpoint()` on a closed DB now correctly reports failure.
- **TUI parsers extracted (P3-17).** `parseMarkdown` / `parseMermaid` are now pure, ANSI-free functions under `packages/tui/src/parsers/`, with colocated unit tests; renderers consume the AST.
- **Unified `Clock` injection (P3-18).** `TelemetryCollector`, `SessionRegistry`, `SessionCompactor`, and `runAgentLoop` now accept an injectable `Clock` (default `Date.now`), matching the already-injected `tree` / `branch-what-if`. `getStats()` / `getMetrics()` are pure reads and no longer end the turn.
- **Naming honesty (P3-19, done).** `tree.fork()` removed (it only moved the pointer — callers now use `selectLeaf`); the `/branch` slash command no longer claims to have "forked a new branch". `SlashCommandRegistry.isSlashCommand` (which only checked the `/` prefix) is renamed to `isSlashSyntax`, and a real `hasCommand(name)` existence check is added. In the final sweep: the review's rename table is applied (`ExtensionPackageManager`→`ExtensionInstaller`, `LiveSessionManager`→`SessionRegistry`, `BranchManager`→`BranchExplorer`, `SlashCommandHandler`→`SlashCommandExecutor`, `TrustStoreData`→`TrustStoreFile`); misnamed behaviours are fixed (`tree.branch()`→`addBranchMarker` with a deprecated alias kept, `package-manager.remove()`→`trash()` since it only quarantines, `getLoadedDocuments()` deleted in favour of `getLoadedModules()`); all compatibility aliases are centralised in `agent-core/src/deprecations.ts` (each marked `@deprecated`, removal target v1.0, guarded by `tests/deprecations.test.ts`); and all 64 `(1:1 对标 …)` provenance-style comments were rewritten as contract descriptions. The remaining out-of-table suffix names (`SandboxManager`/`ProjectTrustManager`/`SessionShareManager`/`WhatIf*`/`sessionData`/`safeHelpers`, `compaction/utils.ts`) and the `@inkpi/tui` `TuiStudio` alias were cleaned in the same convention afterwards (see Known Debt below); the only naming debt left is the structural `Novel*` business prefix in the generic core, which is a packaging change and recorded as such below.
- **Package extraction — the single largest remaining item (P2-9 / P2-10), now done.** `src/rpc/` (daemon / server / client / transports) moved out of `@inkpi/agent-core` into `@inkpi/server`; `src/tui/` (studio / terminal-harness) moved into `@inkpi/tui`. `@inkpi/server` and `@inkpi/tui` already existed as stubs, so this was an *overwrite-the-stub-with-the-complete-version + clear-the-ratchet* operation, not a from-scratch package creation. `SessionRegistry` — a domain object that implements the `SessionStore` port and throws `NoModelConfiguredError` when no model is configured — **stays in `agent-core`** and is re-exported by `@inkpi/server`, keeping `server → core` a clean one-way dependency. All external importers (`bin/inkpi.js`, `scripts/inkpi-standalone.mjs`, and 11 test files) were repointed to the new packages.
- **Core dependencies shrunk to ports-only.** `packages/agent-core/package.json` no longer declares `@inkpi/tui`, `@inkpi/storage`, or `ws`; it depends only on `@inkpi/protocol`, `@inkpi/ai`, `@inkpi/editor-core`. The circular project-reference graph (`tui ↔ agent-core ↔ server`) was broken by pruning `agent-core`'s stale `tui` / `server` / `storage` references.
- **Ratchet `BASELINE` cleared to `{}`.** With `agent-core` provably free of presentation/infrastructure/transport imports, the dependency-direction guard's `BASELINE` is now **empty** — any forbidden import fails CI immediately, and any *new* violation fails the build. The guard also asserts the scanner still detects violations via a synthetic sample, so an "always-green" regression cannot slip in.
- **RPC `withSession()` guard + workflow strategy objects (P2-14, done).** The "get session / not-found throw" boilerplate repeated 9× across `InkPiDaemon`'s method handlers is a single `withSession()` helper; the `@inkpi/server` RPC layer uses a `registerMethod()` registry (no 245-line `switch`). On the pipeline side, the 10× `compatibilityMode === 'legacy-pipeline'` branches inside `WorkflowCoordinator` are replaced by injectable strategy objects (`pipeline/workflow-strategy.ts`: `genericWorkflowStrategy` / `legacyPipelineWorkflowStrategy` + `resolveWorkflowStrategy()`); `PipelineExecutionOptions.compatibilityMode` is gone from the options surface and legacy behaviour is selected by passing the legacy strategy explicitly.
- **TUI components reorganized by atomic design (P3-16).** `packages/tui/src/components/` is now `atoms/` (`Box` / `HStack` / `VStack` / `Spacer`), `molecules/` (`SelectList` / `ScrollView` / `ThinkingAccordion` / `Markdown`), `organisms/` (`Editor`), each with a barrel. The public API — including the `Box` / `HStack` / `VStack` / `Spacer` re-export aliases and `Editor` — is unchanged.
- **Giant classes decomposed along responsibility boundaries (P2-12 / P2-13, done).** The split followed the incremental path (pure functions first, then method splits, then responsibility objects), keeping the suite green at every step:
  - `WorkflowCoordinator` (was ~660 lines / 9 responsibilities) is now a ~215-line assembly facade over collaborators in `pipeline/`: `WorkflowExecutor` (stage loop orchestration, 353 lines), `WorkflowStrategy` (`compatibilityMode` replacement, see P2-14), `StageRegistry` (stage list + lookup), `GateRuleRegistry` (global + per-stage gate rules), `GateEvaluator` via pure `detectGateIssues()` (unit-tested), `RoleInvoker` (role invocation + error semantics), `TelemetryTracer` (span lifecycle), `EventBus` (event fan-out), and pure `mergeLedgers`/`mergeRecords` in `ledger-merge.ts`. The class keeps its public name `WorkflowCoordinator` and its event/behaviour surface unchanged.
  - `runAgentLoop` (was ~375 lines) is now a thin compatibility re-export over the four-stage pipeline in `agent-core/src/turn/`: `TurnContext` (per-turn state carrier) → `ContextTransformer` → `StreamInvoker` → `ToolDispatcher` → `TurnFinalizer`, orchestrated by `AgentLoopRunner`. The two competing tool-concurrency strategies in `loop.ts` / `tools.ts` are merged into one `runWithConcurrency()` helper (`agent-core/src/concurrency.ts`, unit-tested in `tests/concurrency.test.ts`); `executeBatch` and the dispatcher both delegate to it.
  - `TerminalStudio` (was ~494 lines) is now a ~200-line facade composing the three layers in `@inkpi/tui`: `StudioModel` (`studio-model.ts`, all state + transitions, zero ANSI), `StudioView` (`studio-view.ts`, pure rendering incl. `renderEntityAvatar` / `renderDifferential`), and `StudioController` (`studio-controller.ts`, input → state-transition intents). Every previously public field is preserved as a getter delegating to the model, so the public API is unchanged (asserted by `tui-studio.test.ts` / `pi-tui-studio-layout.test.ts`); the historical `TuiStudio` alias now lives in `tui/src/deprecations.ts` (asserted by `tui-deprecations.test.ts`).
  - Behaviour is preserved exactly: `tsc -b` green, full suite green (81 files / 408 tests), dependency ratchet green, new units covered by `pipeline-workflow-strategy.test.ts`, `turn-stages.test.ts`, `concurrency.test.ts`, `deprecations.test.ts`.

### Scope of the remediation — read this before assuming things are fixed

The work completed so far covers **Phase 1 (stop the bleeding, 7/7 done)**, **most of
Phase 2**, and **most of Phase 3** of the roadmap in `ARCHITECTURE_REVIEW.md`:

- **Phase 2 done (8/8):** domain ports declared (#8), `storage` `IDb`/`IRepository` abstraction (#11), `conformance` de-publicised + honest `checkpoint` (#15), **package extraction (#9)**, **core deps removed (#10)**, **RPC `withSession()` + `compatibilityMode` strategy objects (#14)**, **`TerminalStudio` M/V/C split (#12)**, **`WorkflowCoordinator` collaborators + `runAgentLoop` four-stage pipeline (#13)** (see Fixed above).
- **Phase 3 done (5/6):** parsers extracted (#17), unified `Clock` injection (#18), docs synced (#21), **TUI atomic reorg (#16)**, **naming cleanup (#19 — rename table applied, aliases centralised in `deprecations.ts`, misnamed behaviours fixed, provenance comments rewritten; small documented remainders below)**.
- **Phase 3 blocked (1/6):** `perFile` coverage gate (#20) — cannot be measured in this sandbox (see Tooling below).

What this means concretely: **`@inkpi/agent-core` is now a genuine domain core.** It ships
no `src/tui/` and no `src/rpc/`; its only runtime dependencies are `@inkpi/protocol`,
`@inkpi/ai`, and `@inkpi/editor-core`; and the dependency-direction ratchet's `BASELINE`
is **empty**. The hexagonal topology drawn in §1 is now an **accurate description**, not an
aspiration. The three former giant classes are split along responsibility boundaries with
their public surfaces preserved; the remaining debt is small, localised, and listed below.

### Known debt (tracked, NOT yet resolved)

**Structural (Phase 2 — 8/8 done)**
- **Roadmap complete.** All eight Phase-2 items are done; the structural section below records the *residual* hardening opportunities, not unfinished roadmap items.
- **`reducer/session-reducer.ts` in-place mutation: FIXED.** `detectAndMarkInterruptedOperations()` is now a pure, copy-on-write function (`(state, clock?) => { state, recoveredCount, interruptedIds }`); `reduceSessionEntry` likewise never mutates its input. Snapshot-isolation is asserted by `tests/session-reducer.test.ts` (旧快照在 reduce 后保持原值、未触及记录为共享但不可变) and `tests/crash-recovery-e2e.test.ts`.

**Hardcoded / faked values (Phase 1 P1–P2 items)**
- **All resolved** in this sweep:
  - `journal.ts` no longer fabricates token counts — the `ledger_mutation` row binds `tokens_before/after` to `NULL` (no data, never fake `0`).
  - `memory.ts` / `jsonl.ts` omit `rank` on non-FTS results (protocol `FtsSearchResult.rank` is now optional, documented as "honest omission").
  - `sqlite.ts` auto-provisioned `ws_default` / `folder_default` are now injectable via `SqliteSessionBackendOptions.defaultWorkspaceId` / `defaultFolderId` (documented, snapshot-path only).
  - `telemetry.ts` pricing (`2.0` / `8.0` / `0.5` per M tokens) is now constructor-injectable (`{ inputUsdPerMTokens, outputUsdPerMTokens, cacheReadUsdPerMTokens }`); the defaults are documented as *placeholder example prices*, not vendor quotes.
  - `telemetry.ts` emits valid OTel IDs: deterministic 32-hex `traceId` / 16-hex `spanId` via dual FNV-1a rounds (`toOtelHexId`), replacing the invalid `inkpi_trace_` prefix.
  - Token estimation no longer sprinkles magic `0.7`: `CHARS_PER_TOKEN_HEURISTIC = 0.7` is exported once from `@inkpi/ai`, and `CompactionConfig.charsPerToken` makes the factor injectable (`ai/prompt-caching.ts` ×4 + `agent-core/compaction.ts` ×4 all consume it).
  - Loopback binding is a named security constant: `DEFAULT_RPC_HOST = '127.0.0.1'` is exported once per package (`@inkpi/server` `transport.ts`, `@inkpi/client` `types.ts`) and referenced by all 7 connect/listen defaults (incl. `InkPiDaemon`); the WS port default honors injectable `DaemonOptions.wsPort` (`TCP port + 1` fallback only).

**Pure-render / interface hygiene (Phase 3 — naming & shape)**
- **`session-share.ts` `.filter()` mutation side effect: FIXED** — rewritten as a pure `.map()` pipeline (sanitize clones → filter blocks on the clone → spread new message).
- **TUI render side effects: FIXED** — `Editor.render()` and `ScrollView.render()` no longer write component state; `Editor` gains explicit `ensureCursorVisible(viewHeight)` (the sole scroll-state transition), `ScrollView` clamps into a render-local offset.
- **`ISessionBackend.search?()` fake-ISP: FIXED** — `search()` is now a **required** port member (all three backends implement it); non-FTS backends express capability via omitted `rank`, not missing methods.
- **`ExtensionAPI` fat interface: FIXED** — split into 7 capability facets (`ExtensionEventBus` / `ExtensionToolRegistry` / `ExtensionCommandRegistry` / `ExtensionShortcutRegistry` / `ExtensionContextTransformers` / `ExtensionUi` / `ExtensionPipelineHooks`); `ExtensionAPI extends` all of them, so the aggregate name and every implementer/consumer are unchanged.
- **8 `[key: string]: unknown` index signatures in `protocol/src/extensions.ts`: FIXED** — removed from `AgentTool` / `SlashCommand` / `ShortcutHandler` / `SelectListItem` / `SelectListOptions` / `InputDialogOptions` / `FlashNotificationOptions` / `PipelineHooks`; the protocol types now declare only the guaranteed contract (hosts still store registrations as `any`, so extension-owned extra metadata remains pass-through at runtime).

**Interface & naming (Phase 3 — final sweep)**
- **Out-of-table suffixes: FIXED.** `SandboxManager` → `SandboxExecutor` (with `ISandboxRunner` → `SandboxRunner`), `ProjectTrustManager` → `ProjectTrustStore`, `SessionShareManager` → `SessionShareExporter`, `WhatIfBranchInfo` → `HypothesisBranchInfo` (+ `WhatIfExecutiveReport` → `HypothesisExecutiveReport`), `exportDataset`'s `sessionData` parameter → `source`, sandbox's `safeHelpers` local → `sandboxSafeGlobals`, `compaction/utils.ts` → `compaction/summarize.ts`. All renamed compatibility names (`SandboxManager`, `ProjectTrustManager`, `SessionShareManager`, `WhatIf*`) are registered as `@deprecated` aliases in `agent-core/src/deprecations.ts` (guarded by `tests/deprecations.test.ts`).
- **`TuiStudio` alias in `@inkpi/tui`: FIXED** — removed from `studio.ts`; both it and `TerminalWriterHarness` now live in the package's own centralized `tui/src/deprecations.ts` (`@deprecated`, removal v1.0), guarded by the new `tests/tui-deprecations.test.ts`. In-repo tests use the authoritative `TerminalStudio` / `TerminalHarness`.
- **Retained with rationale (name carries meaning, not an empty-generic suffix):** the `Runner` group (`ExtensionRunner` — loads & runs extension modules; `ClipboardCommandRunner` — executes clipboard CLI commands; the interface now `SandboxRunner`), `TerminalHarness` (a terminal test/embed harness). Documented in `ARCHITECTURE_REVIEW.md` §2.13.
- **`Novel*` business prefix: EVALUATED, retained as documented packaging debt.** The prefix is structural, not cosmetic: generic `WorkflowCoordinator` defaults embed *narrative* domain content (`pipeline/legacy-narrative.ts`: `createVisualNovelGateRules()` / `createLegacyNarrativeStages()`), `compaction/state-ledger.ts` exports `extractNovelStateLedger` / `formatNovelStateLedger`, and `@inkpi/evals` ships a `NovelEvalRunner`. Moving it out requires a new domain package (e.g. `@inkpi/novel-pipeline`) that consumes the generic core and supplies the narrative stages/rules/defaults — a packaging change, not a rename. Recommended shape and migration steps are recorded in `ARCHITECTURE_REVIEW.md` §2.13; until then the prefix remains honest (the code is narrative-flavoured at those seams).

**Tooling**
- **`tests/` is now in the TS project graph.** The prior "tests not type-checked" gap is closed — `tests/` is part of `tsc -b` and type errors there fail the build (this also retires the long-standing `tests/tui-harness.test.ts:59` typo).
- **`perFile: true` coverage is not enabled.** Aggregate branch coverage is **81.11%** against an 80% threshold — a margin of ~1.1 points (whole-suite: 91.52% lines / 91.52% stmts / 94.63% funcs). The review's recommendation to gate per-file is still open (environment: the sandbox's safe-delete guard blocks vitest's coverage-dir cleanup, so coverage runs require an escalated shell).
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
