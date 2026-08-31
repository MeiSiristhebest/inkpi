# InkPi 创意工作站与 AI Agent 架构基座

<div align="center">

**面向长篇小说、剧本与专业创作领域的 Agent-Native 可扩展创作工作站引擎**

[English](./README.md) | [中文文档](./README_zh.md) | [开发 SOP](./DEVELOPMENT_SOP.md)

</div>

---

## 📖 项目简介

**InkPi** 是一个模块化、高内聚、面向长文本与创意创作领域的 AI Agent 架构基座。灵感源自 Pi 的经典分层设计，采用 **六边形架构 (Ports & Adapters)** 与 **严格的单一职责原则 (SRP)**，将领域模型、会话持久化、RPC 守护进程与端侧界面彻底解耦。

无论是构建终端 TUI 写作工具、Web 富文本工作台、Obsidian/VS Code 插件，还是无头 Headless 自动化创作代理，InkPi 均可作为统一的底层运行时。

---

## 🏛️ Monorepo 架构与 10 大子包拓扑

```
                       ┌─────────────────────────┐
                       │    @inkpi/protocol      │ (领域契约、TypeBox 与 JSON-RPC 帧)
                       └────────────┬────────────┘
                                    │
          ┌─────────────────────────┼─────────────────────────┐
          │                         │                         │
          ▼                         ▼                         ▼
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│ @inkpi/session-  │      │  @inkpi/server   │      │  @inkpi/client   │
│   backends       │      │  (Daemon & RPC)  │      │  (类型安全 SDK)  │
│ (Memory/Jsonl/   │      └─────────▲────────┘      └──────────────────┘
│  Sqlite 适配器)  │                │
└──────────────────┘                │
          ▲                         │
          ├─────────────────────────┴─────────────────────────┐
          │                                                   │
┌─────────┴────────┐      ┌──────────────────┐      ┌─────────┴────────┐
│ @inkpi/agent-core│      │  @inkpi/ai       │      │  @inkpi/storage  │
│ (AgentEngine 循环│      │  (多模型适配、   │      │  (SQLite、FTS5、 │
│  工作流与状态机) │      │   Prompt Caching)│      │   Lanes 租约)    │
└─────────┬────────┘      └──────────────────┘      └──────────────────┘
          │
    ┌─────┴──────────────────────────┐
    ▼                                ▼
┌──────────────────┐      ┌──────────────────┐
│@inkpi/editor-core│      │   @inkpi/tui     │
│(无头编辑器状态机 │      │ (ANSI 差分渲染、 │
│ 幽灵补全与排版)  │      │  终端图像与布局) │
└──────────────────┘      └──────────────────┘
```

### 子包职责概览

| 子包名称 | 架构职责与定位 | 核心模块 |
| :--- | :--- | :--- |
| **`@inkpi/protocol`** | 纯领域契约与 Schemas | 消息类型、工具契约、状态账本、JSON-RPC 2.0 帧 |
| **`@inkpi/session-backends`** | 可插拔会话持久化端口与适配器 | `ISessionBackend`、`MemorySessionBackend`、`JsonlSessionBackend`、`SqliteSessionBackend` |
| **`@inkpi/server`** | 后台常驻守护进程与服务端 | `InkPiDaemon`、`LiveSessionManager`、`InkRpcServer` |
| **`@inkpi/client`** | 多通道客户端 SDK | `InkRpcClient`、`TcpSocketTransport`、`WebSocketTransport`、`MemoryTransport` |
| **`@inkpi/agent-core`** | 纯 Agent 状态机与执行循环 | `AgentEngine`、`SessionTree`、`WorkflowCoordinator`、`StateLedger` |
| **`@inkpi/editor-core`** | 无头编辑器与创作体验 | `HeadlessEditorState`、`GhostTextManager`、`TypographyEngine` |
| **`@inkpi/storage`** | 工业级本地持久化引擎 | SQLite、FTS5 BM25 全文检索、并发写租约、快照 Compaction |
| **`@inkpi/tui`** | 终端界面与渲染管线 | 差分渲染器 `DifferentialRenderer`、中文 CJK 等宽计算、终端图像展示 |
| **`@inkpi/ai`** | 创作级多模型抽象 | 4 级 Prompt Caching 断点、流式断流恢复、用量账本 |
| **`@inkpi/evals`** | 创作质量基准评测 | 叙事一致性打分、创作质量门禁 |

---

## ⚡ 快速上手

### 依赖要求
- **Node.js**: $\ge 20.0.0$
- **包管理器**: 推荐使用 `pnpm`

### 1. 安装与构建
```bash
# 克隆仓库
git clone https://github.com/MeiSiristhebest/inkpi.git
cd inkpi

# 安装依赖
pnpm install

# 编译所有子包
pnpm run build
```

### 2. 运行自动化测试与覆盖率门禁
```bash
# 运行全量测试套件（行覆盖率 >= 85%, 分支覆盖率 >= 80%）
pnpm run test:coverage
```

### 3. 启动 Headless 常驻服务
```bash
# 启动 RPC 守护进程（默认端口 9876）
pnpm run daemon
```

---

## 🛡️ 质量保证与安全规范

- **供应链加固**：强制锁定确定版本，提供 `pnpm run check:pinned-deps` 校验；
- **单一职责原则 (SRP)**：核心状态机零硬编码命令解释与协议逻辑；
- **高测试覆盖率**：全库 280+ 单元测试用例，覆盖各大异常分支与边界情况。

---

## 📄 开源许可证

本项目遵循 [MIT License](./LICENSE) 开源协议。

---

## ⭐ Star 与支持

如果您觉得本项目对您的学习或创作流程有所启发，欢迎在 GitHub 上点个 ⭐ **Star**！

<p align="center">
  <a href="https://www.star-history.com/?repos=MeiSiristhebest%2Finkpi&type=date&legend=bottom-right">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=MeiSiristhebest/inkpi&type=date&theme=dark&legend=bottom-right" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=MeiSiristhebest/inkpi&type=date&legend=bottom-right" />
      <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=MeiSiristhebest/inkpi&type=date&legend=bottom-right" width="100%" />
    </picture>
  </a>
</p>

### 🤝 贡献者
<a href="https://github.com/MeiSiristhebest/inkpi/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=MeiSiristhebest/inkpi" alt="Contributors" />
</a>

