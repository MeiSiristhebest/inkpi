# InkPi 开发标准作业程序 (Development SOP)

本规范旨在确保 InkPi 项目在持续迭代中保持工业级工程质量、高内聚低耦合的架构纯洁性与确定性的自动化验证。

---

## 🛡️ 一、核心架构与工程原则

1. **SOLID 设计原则与六边形架构 (Ports & Adapters)**：
   - 领域核心与状态机仅依赖抽象端口契约（如 `ISessionBackend`、`Transport`），不直接耦合基础设施层或具体框架；
   - 视图、业务逻辑、持久存储与 RPC 调度彻底解耦为独立 Monorepo 包。
2. **单一原子缺陷专注原则 (Single-Defect Atomic Focus)**：
   - 每次提交或 PR 仅专注单一特性或缺陷修复，保持小步提交（Small-step Commits）；
   - 禁止在单个 PR 中夹带不相关改动。
3. **测试覆盖率硬性门禁 (Quality Gate)**：
   - 全局代码覆盖率：行覆盖率（Lines）$\ge 85\%$，分支覆盖率（Branches）$\ge 80\%$；
   - 新增模块必须附带完整的端到端或单元测试套件，禁止空测试或凑数断言。
4. **供应链与版本锁定规范 (Supply-Chain Hardening)**：
   - 所有外部 npm 依赖项强制使用确定版本（Exact Version），严禁使用 `^` 或 `~` 动态浮动范围；
   - 提交前必须通过 `pnpm run check:pinned-deps` 校验。

---

## 🚀 二、本地开发与构建流转

### 1. 安装依赖与环境初始化
```bash
# 推荐使用 pnpm 进行 Workspace 依赖管理
pnpm install
```

### 2. 构建与类型检查
```bash
# 执行 Monorepo 全量子包 TypeScript 编译
pnpm run build
```

### 3. 测试与质量门禁验证
```bash
# 运行全量 Vitest 测试套件并输出覆盖率报告
pnpm run test:coverage
```

### 4. 依赖安全性校验
```bash
# 检查全包外部依赖版本锁定情况
pnpm run check:pinned-deps
```

---

## 📦 三、Monorepo 包拓扑结构

- `packages/protocol`: 领域数据类型、TypeBox Schemas 与 JSON-RPC 2.0 帧定义
- `packages/session-backends`: 可插拔会话持久化端口契约与三大适配器（Memory / JSONL / SQLite）
- `packages/server`: Headless 常驻守护进程、多会话生命周期与 JSON-RPC 2.0 服务端
- `packages/client`: 类型安全 RPC 客户端 SDK 与多通道传输（TCP / WebSocket / Memory）
- `packages/agent-core`: 纯 Agent 执行引擎（`AgentEngine`）、会话树与工作流协调器
- `packages/editor-core`: 无头编辑器状态机、幽灵文本补全与中文排版引擎
- `packages/storage`: SQLite、FTS5 检索、事件溯源日志与写租约
- `packages/tui`: 终端 ANSI 差分渲染引擎与富交互组件
- `packages/ai`: 多厂商大模型适配、流式断流恢复与 Prompt Caching
- `packages/evals`: 叙事一致性评测与基准测试套件
