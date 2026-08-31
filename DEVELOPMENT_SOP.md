# InkPi Development Standard Operating Procedure (SOP)

This document establishes the engineering standards, architecture invariants, and workflow procedures for the InkPi monorepo.

---

## 🛡️ 1. Core Architectural Invariants

1. **Hexagonal Architecture (Ports & Adapters)**:
   - Core domain logic and state engines must only depend on abstract ports (e.g. `ISessionBackend`, `Transport`), never on concrete database implementations or communication frameworks.
2. **Single-Defect Atomic Focus (RFC-100)**:
   - PRs and commits must remain small, focused, and atomic. Packaged commits with unrelated multi-bug fixes are strictly prohibited.
3. **Quality Gate Thresholds**:
   - Monorepo coverage must strictly satisfy: Lines $\ge 85\%$, Branches $\ge 80\%$.
   - Every new feature or bug fix must include dedicated unit and integration tests.
4. **Supply-Chain Hardening**:
   - All external dependencies in `package.json` files must use exact versions without `^` or `~` ranges.

---

## 🚀 2. Local Development Workflow

### 1. Workspace Installation
```bash
# Recommended package manager: pnpm
pnpm install
```

### 2. Monorepo Build & Typecheck
```bash
pnpm run build
```

### 3. Verification & Coverage Check
```bash
pnpm run test:coverage
```

### 4. Dependency Hardening Audit
```bash
pnpm run check:pinned-deps
```

---

## 📦 3. Package Topology Reference

- `packages/protocol`: Pure TypeBox schemas, domain contracts, and JSON-RPC 2.0 frames
- `packages/session-backends`: Pluggable storage adapters (Memory, JSONL, SQLite with FTS5)
- `packages/server`: Headless background daemon, live session manager, and RPC server
- `packages/client`: Type-safe RPC SDK and multi-transport channels (TCP, WebSocket, Memory)
- `packages/agent-core`: Pure agent state engine (`AgentEngine`), SessionTree, and state ledgers
- `packages/editor-core`: Headless editor state machine, ghost text completion, typography engine
- `packages/storage`: SQLite relational storage, FTS5 search engine, writer leases, and compaction
- `packages/tui`: Terminal differential rendering engine and visual components
- `packages/ai`: Multi-provider abstraction, 4-tier prompt caching breakpoints, and stream resilience
- `packages/evals`: Evaluation benchmark runners and narrative consistency invariant scoring
