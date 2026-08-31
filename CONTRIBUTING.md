# Contributing to InkPi

Thank you for your interest in contributing to InkPi!

## 🛡️ Core Contribution Principles

1. **Strict Single-Defect / Atomic Focus**: PRs must be hyper-focused and minimal.
2. **Test Coverage ($\ge 85\%$ Lines, $\ge 80\%$ Branches)**: All PRs must include unit or integration tests with high branch coverage.
3. **Exact Dependency Pinning**: All dependencies must be strictly pinned without wildcards (`^` or `~`).
4. **No Hardcoding**: Follow clean architecture (Ports & Adapters, SOLID, Separation of Concerns).

## 🚀 Development Workflow

```bash
# 1. Install dependencies
pnpm install

# 2. Build monorepo
pnpm run build

# 3. Run test coverage
pnpm run test:coverage

# 4. Check pinned dependencies
pnpm run check:pinned-deps
```

## 📜 Pull Request Guidelines

- Ensure `pnpm run build` and `pnpm run test:coverage` pass locally before opening a PR.
- Link relevant issues and explain the rationale for changes in detail.
