# AI Runtime RFC v0.1

- Status: Frozen for Phase 0
- Scope: `inkpi` Runtime and `inkpi-desktop` integration boundary
- Owners: InkPi Runtime and InkPi Desktop maintainers

## Decision

`inkpi` is the generic Agent Harness / AI Runtime. `inkpi-desktop` is the
Creative Writing product. Creative Writing concepts belong to the desktop
domain layer and must not become dependencies of Runtime packages.

This RFC freezes the boundaries needed for the later task, context, proposal,
durability, and projection work. It does not freeze the Runtime v1 protocol.
Runtime v1 may be frozen only after the five vertical slices and the remaining
The local Phase 23 gate is implemented; formal Runtime v1 freeze still depends
on the external evidence listed in the specification, including real-provider,
GUI, dual-instance, human-labelled, and production observability checks.

## Frozen invariants

The following wording is normative:

```text
- inkpi = 通用 Agent Harness / AI Runtime
- inkpi 不包含小说、角色、伏笔、章节等 Creative Domain 语义
- inkpi-desktop = Creative Writing 产品
- Desktop IndexedDB = Creative Domain State 唯一权威
- Daemon SQLite 中的 Creative Data 只能是 Projection / Index / Cache
- Runtime 拥有 Session / Execution / Trace / Cache / Artifact 等运行状态
- AI 不得直接修改 Creative Domain State
- AI Domain Mutation 必须 Proposal → Commit
- UI 交互形态不得进入 Runtime 核心协议
- Task 类型必须可扩展，不使用封闭领域枚举
- Generic Context Pipeline 属于 inkpi
- Story Context Compiler 属于 Creative Domain
- Skills 必须复用 ExtensionHost / ToolRegistry / DynamicPluginLoader
- Prompt ≠ Context，二者必须分别建模
- Runtime 不保存或依赖模型私有 CoT
```

In English: `inkpi` is the generic Agent Harness / AI Runtime; it does not
contain Novel, Character, Chapter, Foreshadowing, or other Creative Domain
semantics; and `inkpi-desktop` is the Creative Writing product. Desktop
IndexedDB is the single authoritative source for Creative Domain State.

## Ownership and dependency direction

The dependency direction is:

```text
Desktop UI / Creative Domain
        ↓
Creative Intelligence Layer
        ↓ AiTask and generic ports
InkPi Runtime
        ↓ provider ports
Model Providers
```

The following imports are prohibited:

| Source | Prohibited dependency |
| --- | --- |
| `agent-core` | Novel, Character, Chapter, or Foreshadowing domain modules |
| `protocol` | `inkpi-desktop` or desktop domain modules |
| `storage` | Desktop domain models |
| React components | LLM provider SDKs or provider-specific Runtime modules |
| React components | Direct construction of full Prompts |
| Plugin UI | Direct model calls |

`StoryContextCompiler` must remain in `inkpi-desktop`. It must not be moved
into `@inkpi/agent-core` or another Runtime package.

## State authority and mutation safety

Desktop IndexedDB is authoritative for Creative Domain State. Daemon SQLite
may contain document projections, story projections, summaries, FTS data,
retrieval indexes, embeddings, and AI extraction caches. These records are
derived and must not be treated as a second authoring source.

An AI result that changes a Creative Domain object is a proposal. The desktop
reviews the proposal, validates its base revision and source hash, and commits
it to IndexedDB. A committed change may then be projected to the daemon.

## Runtime protocol boundary

Runtime contracts are generic. Domain-specific behavior is selected by an
open task kind, such as `creative.continue` or
`narrative.continuity.audit`; these strings are supplied by the Creative
Intelligence Layer and are not a closed Runtime domain enum.

Prompt assembly is separate from context compilation:

```text
Instruction + ContextPacket + User Intent + Output Contract
```

The Runtime may own generic context fragments, ranking, budgeting,
deduplication, serialization, caching, and provider routing. It must not own
story entities, chapters, characters, timelines, promises, or other Creative
Domain semantics.

Private model reasoning, `<think>` blocks, and raw CoT are not protocol or
persistence formats. Runtime observability stores public summaries, tool
traces, decision traces, and result provenance only.

## Enforcement

The Phase 0 guards are executable tests:

- `inkpi/tests/ai-runtime-architecture.test.ts` checks Runtime package import
  boundaries.
- `inkpi-desktop/src/architecture-ai.test.ts` checks provider, Prompt, and
  Plugin UI boundaries.

Both repository CI workflows already run Vitest. The guards therefore run in
the existing CI test and coverage jobs without a separate enforcement path.

The desktop guard contains an explicit migration baseline for the existing
legacy Plugin UI Prompt calls. The baseline is a ratchet:

1. A new violation fails CI.
2. Removing a violation requires removing its baseline entry in the same
   change.
3. Baseline entries may only be removed, never added to hide a regression.

This keeps Phase 0 small and preserves the Phase 8 requirement that the 44
plugins are not migrated in bulk before the Runtime and vertical slices are
ready.

## Non-goals for Phase 0

- No Creative Domain model is added to `inkpi`.
- No plugin is migrated.
- No Runtime v1 specification is declared.
- No AI provider is selected by desktop UI or Plugin UI.
- No existing feature is replaced with a large rewrite.

## Phase 0 exit criteria

- This RFC is present under `inkpi/docs/rfcs/`.
- Runtime and desktop architecture guards run as part of their normal CI test
  commands.
- `agent-core` has no imports from the named Creative Domain modules.
- `protocol` and `storage` have no imports into the desktop domain.
- Desktop React components do not add direct LLM provider imports.
- Existing legacy Plugin UI Prompt calls are recorded as a decreasing baseline.
