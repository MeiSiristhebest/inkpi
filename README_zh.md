<!-- 
  Designed & Built with ❤️ by MeiSiristhebest (https://github.com/MeiSiristhebest)
  如果本项目的架构设计、工程实现或工具链对你的学习或工作有所启发，欢迎点亮右上角的 ⭐ Star！
-->
<h1 align="center">🖋️ InkPi</h1>

<p align="center">
  <b><a href="./README.md">English</a> | 简体中文</b>
</p>

> [!TIP]
> 💡 **如果本项目的架构设计、工程实现或工具链对你的学习或工作有所启发，欢迎点亮右上角的 ⭐ Star！**
> 📚 深入探索系统技术架构蓝图：[ARCHITECTURE.md](./ARCHITECTURE.md)

<p align="center">
  <b>面向长文本、复杂工具调用与智能体工作流的 Agent-Native 可扩展架构基座与工作站平台</b>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@inkpi/protocol"><img src="https://img.shields.io/badge/npm-v1.0.0-blue.svg?style=flat" alt="npm version" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=flat" alt="License: MIT" /></a>
</p>

<p align="center">
  <em>一个模块化、工业级的 AI Agent 架构基座与基础设施，为智能体提供离散的工程原语：10 个高度解耦的 Monorepo 子包、可插拔会话持久化后端（Memory/JSONL/SQLite+FTS5）、4 级 Prompt Caching 断点优化以及终端 ANSI 差分渲染 TUI。</em>
</p>

---

## 📑 目录

- [💡 项目概述](#-项目概述)
  - [什么是 InkPi？](#什么是-inkpi)
  - [InkPi 不是什么](#inkpi-不是什么)
  - [架构与分层解耦](#架构与分层解耦)
- [✨ 核心特性](#-核心特性)
  - [1. 10 大子包六边形架构拓扑](#1-10-大子包六边形架构拓扑)
  - [2. 可插拔会话持久化后端](#2-可插拔会话持久化后端)
  - [3. 4 级 Prompt Caching 与断流恢复](#3-4-级-prompt-caching-与断流恢复)
  - [4. 无头编辑器与幽灵补全引擎](#4-无头编辑器与幽灵补全引擎)
  - [5. 终端差分渲染器与 CJK 排版](#5-终端差分渲染器与-cjk-排版)
- [⚙️ 环境依赖](#️-环境依赖)
- [📦 安装与配置](#-安装与配置)
- [🛠️ 源码开发](#️-源码开发)
- [🚀 快速上手](#-快速上手)
  - [1. 统一终端指令集](#1-统一终端指令集)
  - [2. 运行全量测试与覆盖率门禁](#2-运行全量测试与覆盖率门禁)
  - [3. 验证供应链确定版本依赖](#3-验证供应链确定版本依赖)
  - [4. SDK 代码调用示例](#4-sdk-代码调用示例)
- [🛡️ 五大绝对工程不变量](#️-五大绝对工程不变量)
- [🤝 参与贡献](#-参与贡献)
- [📜 开源许可证](#-开源许可证)
- [⭐ Star 与支持](#star-history)

---

## 💡 项目概述

### 什么是 InkPi？

InkPi 是一个灵感源自 Pi 架构的**可扩展 AI Agent 架构基座与工作站底座**。它为各类 AI 智能体（如 Google Antigravity、Claude Code、Cursor、Codex 或自定义自主 Agent）提供离散的工程原语，用于构建具备确定性状态机和持久化存储的长文本 Agent 循环、文档工作流与工具链。

### InkPi 不是什么

- **不是硬编码的单一 Chat 套壳**：不将 Prompt 强耦合在固定的循环中，而是提供模块化的六边形运行时。
- **不是无上限的纯内存草稿纸**：严格强制执行事件溯源日志、快照 Compaction 与并发写租约机制。

### 架构与分层解耦

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
    │  InkPiDaemon · LiveSessionManager · InkRpcServer                 │
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

## ✨ 核心特性

### 1. 10 大子包六边形架构拓扑

InkPi 拆分为 10 个完全解耦、零循环依赖的独立子包：

| 子包名称 | 架构职责与定位 | 核心导出模块 |
| :--- | :--- | :--- |
| **`@inkpi/protocol`** | 纯领域契约与 JSON-RPC 帧 | `SessionEntry`, `DocumentSnapshot`, `DocumentDelta`, `RpcRequest` |
| **`@inkpi/session-backends`** | 可插拔会话持久化存储适配器 | `ISessionBackend`, `MemorySessionBackend`, `JsonlSessionBackend`, `SqliteSessionBackend` |
| **`@inkpi/server`** | 无头守护进程与会话调度器 | `InkPiDaemon`, `LiveSessionManager`, `InkRpcServer` |
| **`@inkpi/client`** | 类型安全客户端 SDK 与传输层 | `InkRpcClient`, `TcpSocketTransport`, `WebSocketTransport`, `MemoryTransport` |
| **`@inkpi/agent-core`** | 推理状态机与会话分支树 | `Agent`, `AgentEngine`, `SessionTree`, `WorkflowCoordinator`, `StateLedger` |
| **`@inkpi/editor-core`** | 无头编辑器与排版引擎 | `HeadlessEditorState`, `GhostTextManager`, `TypographyEngine` |
| **`@inkpi/storage`** | SQLite、FTS5 BM25 检索与写租约 | `InkDb`, `InkRepository`, `FtsSearchEngine`, `AppendOnlySessionJournal` |
| **`@inkpi/tui`** | ANSI 差分渲染与 CJK 排版 | `DifferentialRenderer`, `calculateDisplayWidth`, `TerminalImage` |
| **`@inkpi/ai`** | 多模型适配、Prompt Caching 与流恢复 | `PromptCacheOptimizer`, `streamWithResilience`, `ModelCatalog` |
| **`@inkpi/evals`** | 叙事一致性打分与基准评测 | `NovelConsistencyBenchmark`, `InvariantChecker` |

### 2. 可插拔会话持久化后端

通过统一的 `ISessionBackend` 端口契约自由切换底层存储：
- **`MemorySessionBackend`**：纯内存 Map 存储，零 I/O 开销，适用于确定性单元测试。
- **`JsonlSessionBackend`**：纯追加式 JSONL 文件存储，零 C++ 原生依赖，适用于跨平台轻量部署。
- **`SqliteSessionBackend`**：完整 ACID SQLite 关系型存储，支持 FTS5 BM25 全文检索、快照 Compaction 与写并发租约。

### 3. 4 级 Prompt Caching 与断流恢复

通过 4 级断点缓存最大化降低长上下文推理延迟与成本：
- `系统提示词与世界观法则` $\to$ `设定集与人物档案` $\to$ `章节细纲` $\to$ `滚动历史`。
- 指数退避重连机制，自动恢复意外中断的 SSE 流式长连接且不丢失上下文消息。

### 4. 无头编辑器与幽灵补全引擎

- 纯数据驱动的文档状态机（`HeadlessEditorState`），与终端或浏览器 DOM 彻底解耦。
- `GhostTextManager` 支持逐词（`acceptWord()`）与逐行（`acceptLine()`）的高精度交互式行内补全。

### 5. 终端差分渲染器与 CJK 排版

- ANSI 差分屏幕缓冲区更新算法，大幅降低终端刷新闪烁。
- 精准的中日韩东亚宽字符与歧义字符宽度计算（`calculateDisplayWidth`）。
- 支持 Kitty、Sixel 与 iTerm2 终端原生内嵌图形协议。

---

## ⚙️ 环境依赖

- **Node.js**: $\ge 22.0.0$（推荐 LTS 版本）

---

## 📦 安装与配置

**curl 一键安装**（Linux / macOS）：
```bash
curl -fsSL https://raw.githubusercontent.com/MeiSiristhebest/inkpi/master/scripts/install.sh | sh
```

**PowerShell 一键安装**（Windows）：
```powershell
iwr https://raw.githubusercontent.com/MeiSiristhebest/inkpi/master/scripts/install.ps1 | iex
```

**npm 全局安装**：
```bash
npm install -g --ignore-scripts @inkpi/creative-agent
```

**pnpm 全局安装**：
```bash
pnpm add -g --ignore-scripts @inkpi/creative-agent
```

**bun 全局安装**：
```bash
bun install -g @inkpi/creative-agent
```

**npx 免装即用**：
```bash
npx @inkpi/creative-agent
```

---

## 🛠️ 源码开发

```bash
# 克隆代码仓库
git clone https://github.com/MeiSiristhebest/inkpi.git
cd inkpi

# 安装 Monorepo 依赖（跳过生命周期脚本）
pnpm install --ignore-scripts

# 编译所有 10 个子包
pnpm run build

# 运行单元测试
pnpm run test:coverage
```

---

## 🚀 快速上手

### 1. 统一终端指令集

| 指令 | 描述 | 示例 |
| :--- | :--- | :--- |
| `inkpi` / `inkpi studio` | 启动交互式终端创作工作台（TUI） | `inkpi` |
| `inkpi init [name]` | 初始化结构化小说创作工程目录 | `inkpi init my-novel` |
| `inkpi write <chapter>` | 在沉浸式工作台模式下打开指定章节 | `inkpi write chapters/01.md` |
| `inkpi daemon` | 启动后台 Headless JSON-RPC 2.0 守护进程 | `inkpi daemon --port 8848` |
| `inkpi doctor` | 诊断 Node 环境、SQLite 引擎与 API 密钥配置 | `inkpi doctor` |
| `inkpi print -p <text>` | 单次非交互式叙事生成推理 | `inkpi -p "描写一段开场场景"` |

### 2. 运行全量测试与覆盖率门禁

```bash
pnpm run test:coverage
```

### 3. 验证供应链确定版本依赖

```bash
pnpm run check:pinned-deps
```

### 4. SDK 代码调用示例

```typescript
import { LiveSessionManager } from '@inkpi/server';
import { MemorySessionBackend } from '@inkpi/session-backends';
import { InkRpcClient, InMemoryTransport } from '@inkpi/client';

// 1. 初始化搭载可插拔存储后端的会话调度管理器
const sessionManager = new LiveSessionManager(() => new MemorySessionBackend());
const session = sessionManager.createSession('novel_session_1', {
  initialText: '# 第一章：觉醒\n\n'
});

// 2. 向无头编辑器中插入文本
session.editor.insertText(10, '天际划过一道璀璨的流星。');
console.log(session.editor.getText());
```

---

## 🛡️ 五大绝对工程不变量

1. **严格单一职责原则 (SRP)**：
   `AgentEngine` 核心状态机与斜杠指令解析、RPC 协议帧完全解耦。
2. **基于端口与适配器的可插拔持久化**：
   领域模型仅依赖 `ISessionBackend` 接口契约。
3. **严格质量门禁（$\ge 85\%$ 行，$\ge 80\%$ 分支）**：
   所有 Pull Request 均在 Linux、macOS 和 Windows 下通过 280+ 个单测与集成测试校验。
4. **供应链依赖安全加固**：
   所有外部依赖均采用确定版本锁定，严禁使用漂移范围操作符（`^` 或 `~`）。
5. **确定性事件溯源**：
   所有状态变更均在追加式日记账中持久化记录，支持无损撤销、重放与分支演进。

---

## 🤝 参与贡献

欢迎参与贡献！提交 Pull Request 前请阅读 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 与 [`DEVELOPMENT_SOP.md`](./DEVELOPMENT_SOP.md)。

---

## 📜 开源许可证

本项目遵循 [MIT License](./LICENSE) 开源协议。Copyright (c) 2026 InkPi Contributors.

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
