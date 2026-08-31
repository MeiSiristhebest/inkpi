# InkPi Technical Architecture Blueprint

This document details the architectural design, hexagonal ports & adapters topology, and domain model of **InkPi**.

---

## 🏛️ 1. Hexagonal Ports & Adapters Architecture

InkPi strictly separates domain logic from interface drivers and persistence adapters:

```text
    ┌──────────────────────────────────────────────────────────────────┐
    │                      External Client / UI Layer                  │
    │        Terminal TUI · Web Workspace · VS Code Extension          │
    │                                                                  │
    │  @meisiristhebest/client · @meisiristhebest/tui · JSON-RPC 2.0 Client                │
    └───────────────────────────┬──────────────────────────────────────┘
                                │ JSON-RPC 2.0 / TCP / WebSocket
                                ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │                  @meisiristhebest/server (Daemon Runtime)                  │
    │                                                                  │
    │  InkPiDaemon · LiveSessionManager · InkRpcServer                 │
    └───────────────────────────┬──────────────────────────────────────┘
                                │ In-process typed dispatch
                                ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │            @meisiristhebest/agent-core (Domain State Engine)               │
    │                                                                  │
    │  AgentEngine · Agent Loop · SessionTree · WorkflowCoordinator    │
    │  StateLedger · ToolRegistry · ExtensionHost · Queues             │
    └──────────────┬───────────────────────────────┬───────────────────┘
                   │                               │
                   ▼ ISessionBackend Port          ▼ AIProvider Port
    ┌──────────────────────────────┐ ┌─────────────────────────────────┐
    │   @meisiristhebest/session-backends    │ │          @meisiristhebest/ai              │
    │                              │ │                                 │
    │  • MemorySessionBackend      │ │  • ModelCatalog                 │
    │  • JsonlSessionBackend       │ │  • PromptCacheOptimizer         │
    │  • SqliteSessionBackend      │ │  • streamWithResilience         │
    └──────────────────────────────┘ └─────────────────────────────────┘
```

---

## 📦 2. 10-Package Decoupled Monorepo Structure

1. **`@meisiristhebest/protocol`**: Pure domain schemas, TypeBox types, and JSON-RPC frames. Zero runtime dependencies.
2. **`@meisiristhebest/session-backends`**: Pluggable storage backend adapters implementing the `ISessionBackend` contract with full LSP conformance.
3. **`@meisiristhebest/server`**: Headless daemon, multi-session lifecycle scheduler, and RPC server.
4. **`@meisiristhebest/client`**: Multi-transport client SDK (TCP Socket, WebSocket, In-Memory).
5. **`@meisiristhebest/agent-core`**: Core reasoning loop, bidirectional queues (Steering & Follow-up), and state ledger.
6. **`@meisiristhebest/editor-core`**: Headless editor state machine, ghost text completion, and Chinese typography engine.
7. **`@meisiristhebest/storage`**: SQLite relational engine, FTS5 BM25 search, concurrency lanes, and writer leases.
8. **`@meisiristhebest/tui`**: ANSI differential rendering pipeline, CJK width calculation, and terminal images.
9. **`@meisiristhebest/ai`**: Multi-provider abstractions, 4-tier prompt caching breakpoints, and stream reconnection.
10. **`@meisiristhebest/evals`**: Evaluation benchmarks and narrative consistency scoring.

---

## 🛡️ 3. Core Architectural Invariants

- **Strict Single Responsibility Principle (SRP)**: Pure state machines do not parse commands or handle RPC protocols.
- **Pluggable Persistence via Ports & Adapters**: `ISessionBackend` allows switching storage engines without touching business logic.
- **Exact Version Pinning**: All dependencies are locked to exact versions without dynamic floating ranges.
- **Coverage Gate**: Every PR must meet $\ge 85\%$ line coverage and $\ge 80\%$ branch coverage.
