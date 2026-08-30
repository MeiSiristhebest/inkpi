# InkPi

> Extensible AI Agent Creative Harness & Workstation Platform (Inspired by Pi Architecture)

InkPi is a modular, domain-agnostic foundation for AI-assisted creative workflows (novels, screenplays, visual novels, short dramas, technical documents).

## Monorepo Packages

- `@inkpi/protocol`: Communication protocols, TypeBox schemas, JSON-RPC 2.0 frames
- `@inkpi/agent-core`: Agent loop, SessionTree, WorkflowCoordinator, StateLedger, ExtensionHost
- `@inkpi/tui`: Terminal UI primitives, layout system, DiffRenderer, TerminalImage, Mermaid ASCII
- `@inkpi/ai`: Multi-provider abstraction, streaming, prompt caching, usage tracking
- `@inkpi/editor-core`: Headless editor state machine, ghost text, typography
- `@inkpi/storage`: SQLite & FTS5 search, event-sourcing, lanes, writer leases
- `@inkpi/evals`: Evaluation benchmark suite, invariant scoring

## Available Scripts

- `npm run check`: Pinned dependencies & TypeScript build check
- `npm run test:coverage`: Run test suite with strict coverage enforcement (Lines>=85%, Branches>=80%)
- `npm run lint`: Biome lint check
- `npm run build`: Monorepo build

## License

MIT License (c) 2026 InkPi Contributors.
