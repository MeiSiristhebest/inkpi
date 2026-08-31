# InkPi

> Extensible AI Agent Creative Harness & Workstation Platform (Inspired by Pi Architecture)

InkPi is a high-performance, modular, domain-agnostic foundation for AI-assisted creative workflows (novels, screenplays, visual novels, short dramas, and structured creative documentation).

---

## 🏛️ Monorepo Package Topology (10 Packages)

```
                       ┌─────────────────────────┐
                       │    @inkpi/protocol      │ (Schemas, frames, and domain types)
                       └────────────┬────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
          ▼                         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ @inkpi/session-  │      │  @inkpi/server   │      │  @inkpi/client   │
│   backends       │      │  (Daemon & RPC)  │      │  (Type-safe SDK) │
│ (Memory/Jsonl/   │      └─────────▲────────┘      └──────────────────┘
│  Sqlite Adapters)│                │
└──────────────────┘                │
          ▲                         │
          ├─────────────────────────┴─────────────────────────┐
          │                                                   │
┌─────────┴────────┐      ┌──────────────────┐      ┌─────────┴────────┐
│ @inkpi/agent-core│      │  @inkpi/ai       │      │  @inkpi/storage  │
│ (Engine, Tree,   │      │  (Providers,     │      │  (SQLite, FTS5,  │
│  Pipelines)      │      │   Prompt-Cache)  │      │   Lanes, Leases) │
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

| Package | Description |
| :--- | :--- |
| **`@inkpi/protocol`** | Pure domain contracts, TypeBox schemas, JSON-RPC 2.0 frames, and event types |
| **`@inkpi/session-backends`** | Pluggable session storage backends (`MemorySessionBackend`, `JsonlSessionBackend`, `SqliteSessionBackend`) with LSP conformance |
| **`@inkpi/server`** | Headless daemon (`InkPiDaemon`), multi-session lifecycle (`LiveSessionManager`), and JSON-RPC 2.0 server |
| **`@inkpi/client`** | Type-safe client SDK (`InkRpcClient`) and multi-transport channels (TCP, WebSocket, Memory) |
| **`@inkpi/agent-core`** | Pure Agent execution engine (`AgentEngine`), SessionTree, WorkflowCoordinator, StateLedger, and ExtensionHost |
| **`@inkpi/editor-core`** | Headless editor state machine, ghost text completion, and typography formatting |
| **`@inkpi/storage`** | SQLite, FTS5 BM25 search, append-only journal, concurrency lanes, and writer leases |
| **`@inkpi/tui`** | Terminal UI primitives, layout system, DifferentialRenderer, terminal images (Kitty/Sixel/iTerm2), and CJK width handling |
| **`@inkpi/ai`** | Multi-provider abstraction, resilient streams, 4-tier prompt caching, and model catalog |
| **`@inkpi/evals`** | Evaluation benchmark runner and narrative consistency scoring suite |

---

## 🛠️ Available Scripts

- `npm run build`: Monorepo TypeScript build (`tsc -b`) across all 10 packages
- `npm run test:coverage`: Run complete test suite with strict coverage enforcement (Lines $\ge 85\%$, Branches $\ge 80\%$)
- `npm run check:pinned-deps`: Verify exact dependency locking across all packages
- `npm run build:binaries`: Build standalone single-file executable binary (`inkpi.exe` / `inkpi`)
- `npm run lint`: Biome lint check
- `npm run format`: Biome code formatting

---

## 📄 License

MIT License (c) 2026 InkPi Contributors.
