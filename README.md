<div align="center">

# 🖋️ InkPi

**The Extensible AI Agent Creative Harness & Workstation Platform**  
*Inspired by Pi Architecture — 10-Package Decoupled Monorepo, Pluggable Session Backends, 4-Tier Prompt Caching & Differential TUI*

[![CI](https://github.com/MeiSiristhebest/inkpi/actions/workflows/ci.yml/badge.svg)](https://github.com/MeiSiristhebest/inkpi/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-blue.svg)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20%2B%20%7C%2022%2B-brightgreen.svg)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-9.x-orange.svg)](https://pnpm.io/)
[![Coverage](https://img.shields.io/badge/Coverage-94.7%25-success.svg)](https://github.com/MeiSiristhebest/inkpi)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://makeapullrequest.com)

[English](./README.md) | [中文说明](./README_zh.md) | [Development SOP](./DEVELOPMENT_SOP.md) | [Contributing](./CONTRIBUTING.md)

</div>

---

## 📖 Overview

**InkPi** is a high-performance, domain-agnostic foundation for AI-assisted creative workflows (novels, screenplays, visual novels, short dramas, and structured creative documentation).

Architected around the **Hexagonal Ports & Adapters Architecture** and strict **Single Responsibility Principle (SRP)**, InkPi decouples the pure reasoning state machine, session storage adapters, RPC daemon scheduling, and headless editor engines into 10 cohesive, independently versioned packages.

Whether powering an interactive terminal TUI, a web-based rich text editor, an Obsidian / VS Code extension, or an autonomous headless agent pipeline, InkPi serves as the deterministic creative harness.

---

## 🏛️ Monorepo Package Topology (10 Packages)

```
                       ┌─────────────────────────┐
                       │    @inkpi/protocol      │ (Pure Domain Contracts & JSON-RPC Frames)
                       └────────────┬────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
          ▼                         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ @inkpi/session-  │      │  @inkpi/server   │      │  @inkpi/client   │
│   backends       │      │  (Daemon & RPC)  │      │  (Type-Safe SDK) │
│ (Memory/Jsonl/   │      └─────────▲────────┘      └──────────────────┘
│  Sqlite Adapters)│                │
└──────────────────┘                │
          ▲                         │
          ├─────────────────────────┴─────────────────────────┐
          │                                                   │
┌─────────┴────────┐      ┌──────────────────┐      ┌─────────┴────────┐
│ @inkpi/agent-core│      │  @inkpi/ai       │      │  @inkpi/storage  │
│ (AgentEngine &   │      │  (Providers,     │      │  (SQLite, FTS5,  │
│  StateLedger)    │      │   Prompt Cache)  │      │   Lanes, Leases) │
└─────────┬────────┘      └──────────────────┘      └──────────────────┘
          │
    ┌─────┴──────────────────────────┐
    ▼                                ▼
┌──────────────────┐      ┌──────────────────┐
│@inkpi/editor-core│      │   @inkpi/tui     │
│(Headless Editor, │      │ (ANSI Diff TUI,  │
│ Ghost Text, IME) │      │  Image, Unicode) │
└──────────────────┘      └──────────────────┘
```

### Monorepo Packages Breakdown

| Package | Role & Responsibility (Aligned with Pi) | Core Exports |
| :--- | :--- | :--- |
| **[`@inkpi/protocol`](./packages/protocol)** | Pure domain contracts, TypeBox schemas, JSON-RPC 2.0 frames, and event types | `SessionEntry`, `DocumentSnapshot`, `DocumentDelta`, `RpcRequest`, `RpcResponse` |
| **[`@inkpi/session-backends`](./packages/session-backends)** | Pluggable session storage backends with 100% LSP conformance | `ISessionBackend`, `MemorySessionBackend`, `JsonlSessionBackend`, `SqliteSessionBackend` |
| **[`@inkpi/server`](./packages/server)** | Headless daemon, multi-session lifecycle, and JSON-RPC 2.0 dispatching | `InkPiDaemon`, `LiveSessionManager`, `InkRpcServer` |
| **[`@inkpi/client`](./packages/client)** | Type-safe client SDK and multi-transport channels | `InkRpcClient`, `TcpSocketTransport`, `WebSocketTransport`, `MemoryTransport` |
| **[`@inkpi/agent-core`](./packages/agent-core)** | Pure Agent execution engine (`AgentEngine`), SessionTree, and StateLedger | `Agent`, `AgentEngine`, `SessionTree`, `WorkflowCoordinator`, `StateLedger` |
| **[`@inkpi/editor-core`](./packages/editor-core)** | Headless editor state machine, ghost text, and Chinese typography | `HeadlessEditorState`, `GhostTextManager`, `TypographyEngine` |
| **[`@inkpi/storage`](./packages/storage)** | Industrial-grade SQLite, FTS5 BM25 search, concurrency lanes, writer leases | `InkDb`, `InkRepository`, `FtsSearchEngine`, `AppendOnlySessionJournal` |
| **[`@inkpi/tui`](./packages/tui)** | ANSI differential rendering, CJK width calculation, terminal images | `DifferentialRenderer`, `calculateDisplayWidth`, `TerminalImage` |
| **[`@inkpi/ai`](./packages/ai)** | Multi-provider abstraction, 4-tier prompt caching breakpoints, stream retries | `PromptCacheOptimizer`, `streamWithResilience`, `ModelCatalog` |
| **[`@inkpi/evals`](./packages/evals)** | Narrative consistency evaluation runner and benchmark scoring | `NovelConsistencyBenchmark`, `InvariantChecker` |

---

## ⚡ Quick Start

### Prerequisites
- **Node.js**: $\ge 20.0.0$
- **Package Manager**: `pnpm` $\ge 9.0.0$

### 1. Installation & Monorepo Setup
```bash
# Clone the repository
git clone https://github.com/MeiSiristhebest/inkpi.git
cd inkpi

# Install dependencies via pnpm workspace
pnpm install

# Build all 10 monorepo packages with TypeScript project references
pnpm run build
```

### 2. Run Test Coverage & Quality Gate
```bash
# Execute comprehensive 65-file test suite with strict coverage enforcement
pnpm run test:coverage
```

### 3. Supply-Chain Hardening Check
```bash
# Verify that all external dependencies are pinned to exact versions
pnpm run check:pinned-deps
```

---

## 🛡️ Core Engineering Invariants

1. **Strict Single Responsibility Principle (SRP)**:
   The `AgentEngine` state machine is decoupled from slash command interpretations and RPC framing. Each responsibility belongs exclusively to its designated package.
2. **Pluggable Persistence via Ports & Adapters**:
   Domain logic relies entirely on the `ISessionBackend` interface. Switch between `Memory` (testing), `JSONL` (serverless/edge), and `SQLite` (full ACID + FTS5) with zero business logic changes.
3. **Rigorous Quality Gate ($\ge 85\%$ Lines, $\ge 80\%$ Branches)**:
   Every pull request is verified against 280+ unit and integration tests across Linux, macOS, and Windows.
4. **Supply-Chain Security**:
   All dependencies are locked to exact versions without floating range operators (`^` or `~`).

---

## 🤝 Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`DEVELOPMENT_SOP.md`](./DEVELOPMENT_SOP.md) before submitting pull requests.

---

## 📜 License

Distributed under the [MIT License](./LICENSE). Copyright (c) 2026 InkPi Contributors.
