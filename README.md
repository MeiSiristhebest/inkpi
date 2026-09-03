<!-- 
  Designed & Built with ❤️ by MeiSiristhebest (https://github.com/MeiSiristhebest)
  If this repository helps your learning or engineering, please consider dropping a ⭐ Star!
-->
<h1 align="center">🖋️ InkPi</h1>

<p align="center">
  <b>English | <a href="./README_zh.md">简体中文</a></b>
</p>

> [!TIP]
> 💡 **If this architecture, engineering implementation, or toolchain helps your learning or workflow, please drop a ⭐ Star!**
> 📚 Explore the technical blueprint: [ARCHITECTURE.md](./ARCHITECTURE.md)

<p align="center">
  <b>The Extensible AI Agent Harness & Workstation Platform</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@inkpi/protocol"><img src="https://img.shields.io/badge/npm-v1.0.0-blue.svg?style=flat" alt="npm version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="License: MIT" /></a>
</p>

<p align="center">
  <em>A modular, industrial-grade agent harness infrastructure providing AI agents with discrete engineering primitives: 10-package decoupled Monorepo, pluggable session backends (Memory/JSONL/SQLite+FTS5), 4-tier prompt caching breakpoints, and differential ANSI TUI.</em>
</p>

---

## 📑 Table of Contents

- [💡 Overview](#-overview)
  - [What is InkPi?](#what-is-inkpi)
  - [What InkPi is NOT](#what-inkpi-is-not)
  - [Architecture & Decoupled Layers](#architecture--decoupled-layers)
- [✨ Key Capabilities](#-key-capabilities)
  - [1. 10-Package Hexagonal Topology](#1-10-package-hexagonal-topology)
  - [2. Pluggable Session Backends](#2-pluggable-session-backends)
  - [3. 4-Tier Prompt Caching & Stream Resilience](#3-4-tier-prompt-caching--stream-resilience)
  - [4. Headless Buffer & Ghost Text Engine](#4-headless-buffer--ghost-text-engine)
  - [5. Terminal Differential Renderer & CJK Layout](#5-terminal-differential-renderer--cjk-layout)
- [⚙️ Requirements](#️-requirements)
- [📦 Installation & Setup](#-installation--setup)
- [🚀 Quick Start](#-quick-start)
- [🛡️ The 5 Absolute Engineering Invariants](#️-the-5-absolute-engineering-invariants)
- [🤝 Contributing](#-contributing)
- [📜 License](#-license)
- [⭐ Star & Support](#-star--support)

---

## 💡 Overview

### What is InkPi?

InkPi is an **extensible AI agent harness and workstation foundation** inspired by Pi's architecture. It provides AI agents (such as Google Antigravity, Claude Code, Cursor, Codex, or custom autonomous agents) with discrete engineering primitives to construct long-context agent loops, documents, workflows, and tools with deterministic state machines and durable persistence.

### What InkPi is NOT

- **NOT a Monolithic Chat Wrapper**: It does not bundle prompts inside hardcoded loops; it provides a modular hexagonal runtime.
- **NOT an Unbounded In-Memory Scratchpad**: It enforces event-sourcing journals, snapshot compaction, and concurrency leases.

### Architecture & Decoupled Layers

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
    │                  @inkpi/server (Daemon Runtime)                  │
    │                                                                  │
    │  InkPiDaemon · SessionRegistry · InkRpcServer                    │
    └───────────────────────────┬──────────────────────────────────────┘
                                │ In-process typed dispatch
                                ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │            @inkpi/agent-core (Domain State Engine)               │
    │                                                                  │
    │  AgentEngine · Agent Loop · SessionTree · WorkflowCoordinator    │
    │  StateLedger · ToolRegistry · ExtensionHost · Queues             │
    └──────────────┬───────────────────────────────┬───────────────────┘
                   │                               │
                   ▼ ISessionBackend Port          ▼ AIProvider Port
    ┌──────────────────────────────┐ ┌─────────────────────────────────┐
    │   @inkpi/session-backends    │ │          @inkpi/ai              │
    │                              │ │                                 │
    │  • MemorySessionBackend      │ │  • ModelCatalog                 │
    │  • JsonlSessionBackend       │ │  • PromptCacheOptimizer         │
    │  • SqliteSessionBackend      │ │  • streamWithResilience         │
    └──────────────────────────────┘ └─────────────────────────────────┘
```

---

## ✨ Key Capabilities

### 1. 10-Package Hexagonal Topology

InkPi is divided into 10 decoupled packages with zero cyclic dependencies:

| Package | Responsibility | Core Exports |
| :--- | :--- | :--- |
| **`@inkpi/protocol`** | Pure domain schemas & JSON-RPC frames | `SessionEntry`, `DocumentSnapshot`, `DocumentDelta`, `RpcRequest` |
| **`@inkpi/session-backends`** | Pluggable session storage adapters | `ISessionBackend`, `MemorySessionBackend`, `JsonlSessionBackend`, `SqliteSessionBackend` |
| **`@inkpi/server`** | Headless daemon & session manager | `InkPiDaemon`, `SessionRegistry`, `InkRpcServer` |
| **`@inkpi/client`** | Type-safe client SDK & transports | `InkRpcClient`, `TcpSocketTransport`, `WebSocketTransport`, `MemoryTransport` |
| **`@inkpi/agent-core`** | Reasoning engine & session trees | `Agent`, `SessionTree`, `WorkflowCoordinator`, `StateLedger` |
| **`@inkpi/editor-core`** | Headless editor & typography | `HeadlessEditorState`, `GhostTextManager`, `TypographyEngine` |
| **`@inkpi/storage`** | SQLite, FTS5 BM25 search, leases | `InkDb`, `InkRepository`, `FtsSearchEngine`, `AppendOnlySessionJournal` |
| **`@inkpi/tui`** | ANSI diff rendering & CJK layout | `TerminalStudio`, `DifferentialRenderer`, `calculateDisplayWidth`, `TerminalImage` |
| **`@inkpi/ai`** | Providers, prompt caching, streams | `PromptCacheOptimizer`, `streamWithResilience`, `ModelCatalog` |
| **`@inkpi/evals`** | Narrative consistency scoring | `NovelConsistencyBenchmark`, `InvariantChecker` |

### 2. Pluggable Session Backends

Switch persistence backends via the unified `ISessionBackend` port contract:
- **`MemorySessionBackend`**: Pure in-memory Map storage with zero I/O for deterministic testing.
- **`JsonlSessionBackend`**: Pure append-only JSONL files with zero C++ native bindings for cross-platform edge deployments.
- **`SqliteSessionBackend`**: Full ACID SQLite relational storage with FTS5 BM25 full-text search, snapshots, and concurrency leases.

### 3. 4-Tier Prompt Caching & Stream Resilience

Optimizes long-context inference cost and latency through 4-tier breakpoint caching:
- `System Prompt & World Rules` $\to$ `Character Lore & Codex` $\to$ `Chapter Outline` $\to$ `Rolling History`.
- Exponential backoff stream reconnection automatically recovers dropped SSE connections without losing message history.

### 4. Headless Editor & Ghost Text Engine

- Pure data-driven document state machine (`HeadlessEditorState`) decoupled from terminal or browser DOMs.
- `GhostTextManager` supporting granular word-by-word (`acceptWord()`) and line-by-line (`acceptLine()`) interactive inline autocomplete.

### 5. Terminal Differential Renderer & CJK Layout

- ANSI differential screen buffer updater minimizing flickering.
- Accurate East Asian Ambiguous character width calculation (`calculateDisplayWidth`).
- Kitty, Sixel, and iTerm2 terminal inline graphics protocol support.

---

## ⚙️ Requirements

- **Node.js**: $\ge 22.0.0$ (LTS recommended)

---

## 📦 Installation

**curl** (Linux / macOS):
```bash
curl -fsSL https://raw.githubusercontent.com/MeiSiristhebest/inkpi/master/scripts/install.sh | sh
```

**PowerShell** (Windows):
```powershell
iwr https://raw.githubusercontent.com/MeiSiristhebest/inkpi/master/scripts/install.ps1 | iex
```

**npm**:
```bash
npm install -g --ignore-scripts @inkpi/creative-agent
```

**pnpm**:
```bash
pnpm add -g --ignore-scripts @inkpi/creative-agent
```

**bun**:
```bash
bun install -g @inkpi/creative-agent
```

**npx** (Instant execution without global installation):
```bash
npx @inkpi/creative-agent
```

---

## 🛠️ Source Development

```bash
# Clone the repository
git clone https://github.com/MeiSiristhebest/inkpi.git
cd inkpi

# Install monorepo dependencies (without lifecycle scripts)
pnpm install --ignore-scripts

# Compile all 10 packages
pnpm run build

# Run tests
pnpm run test:coverage
```

---

## 🚀 Quick Start

### 1. Unified CLI Commands

| Command | Action | Example |
| :--- | :--- | :--- |
| `inkpi` / `inkpi studio` | Launch interactive terminal creative workstation (TUI) | `inkpi` |
| `inkpi init [name]` | Scaffold a new structured creative workspace | `inkpi init my-novel` |
| `inkpi write <chapter>` | Open a specific chapter in immersive studio mode | `inkpi write chapters/01.md` |
| `inkpi daemon` | Start headless background JSON-RPC 2.0 daemon | `inkpi daemon --port 8848` |
| `inkpi doctor` | Diagnose Node environment, SQLite engine, API keys | `inkpi doctor` |
| `inkpi print -p <text>` | Single-shot headless non-interactive creative generation | `inkpi -p "Write an intro scene"` |

### 2. Run Complete Test Suite & Coverage Gate

```bash
pnpm run test:coverage
```

### 3. Verify Supply-Chain Hardened Dependencies

```bash
pnpm run check:pinned-deps
```

### 4. Programmatic SDK Usage Example

```typescript
import { SessionRegistry } from '@inkpi/server';
import { MemorySessionBackend } from '@inkpi/session-backends';
import { InkRpcClient, MemoryTransport } from '@inkpi/client';

// 1. Initialize session manager with pluggable storage backend
const sessionManager = new SessionRegistry(() => new MemorySessionBackend());
const session = sessionManager.createSession('novel_session_1', {
  initialText: '# Chapter 1: The Great Awakening\n\n'
});

// 2. Insert text into headless editor
session.editor.insertText(33, 'The stars aligned in the northern sky.');
console.log(session.editor.getText());
```

---

## 🛡️ The 5 Absolute Engineering Invariants

1. **Strict Single Responsibility Principle (SRP)**:
   The `AgentEngine` state machine is decoupled from slash command interpretations and RPC framing.
2. **Pluggable Persistence via Ports & Adapters**:
   Domain logic relies entirely on the `ISessionBackend` interface.
3. **Rigorous Quality Gate ($\ge 85\%$ Lines, $\ge 80\%$ Branches)**:
   Every pull request is verified against 415 unit and integration tests across Linux, macOS, and Windows.
4. **Supply-Chain Security**:
   All dependencies are locked to exact versions without floating range operators (`^` or `~`).
5. **Deterministic Event Sourcing**:
   Every state transition is tracked in append-only journals for lossless undo, replay, and branch branching.

---

## 🤝 Contributing

Contributions are welcome! Please read [`CONTRIBUTING.md`](./CONTRIBUTING.md) and [`DEVELOPMENT_SOP.md`](./DEVELOPMENT_SOP.md) before submitting pull requests.

---

## 📜 License

Distributed under the [MIT License](./LICENSE). Copyright (c) 2026 InkPi Contributors.

---

## Star History

<a href="https://www.star-history.com/?repos=MeiSiristhebest%2Finkpi&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=MeiSiristhebest/inkpi&type=date&theme=dark&legend=bottom-right&sealed_token=fw4uQNigmISCXcdUHho6rq5smpyrxKbwy5S1ZECqDTgTqst9KXiETBJ9kH5YB-ZJJUUJSsFrdft2TQjQA8w-5khguCk8CzjEwNmr1dzKLvM7sltFy2jWfA" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=MeiSiristhebest/inkpi&type=date&legend=bottom-right&sealed_token=fw4uQNigmISCXcdUHho6rq5smpyrxKbwy5S1ZECqDTgTqst9KXiETBJ9kH5YB-ZJJUUJSsFrdft2TQjQA8w-5khguCk8CzjEwNmr1dzKLvM7sltFy2jWfA" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=MeiSiristhebest/inkpi&type=date&legend=bottom-right&sealed_token=fw4uQNigmISCXcdUHho6rq5smpyrxKbwy5S1ZECqDTgTqst9KXiETBJ9kH5YB-ZJJUUJSsFrdft2TQjQA8w-5khguCk8CzjEwNmr1dzKLvM7sltFy2jWfA" />
 </picture>
</a>

### 🤝 Contributors
<a href="https://github.com/MeiSiristhebest/inkpi/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MeiSiristhebest/inkpi" alt="Contributors" />
</a>


