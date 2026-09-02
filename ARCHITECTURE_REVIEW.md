# InkPi 架构评审报告

> 评审视角：资深软件架构师
> 评审基准：你列出的 15 项原则
> 代码基线：`packages/*/src`（141 个源文件）、`tests/`（67 个测试文件）
> 所有结论均已逐条核验到 `文件:行号`

> **整改状态（Remediation status）**：
> - **阶段 1（止血）**：7/7 已完成（`tests/` 已纳入 `tsc -b`，动态端口已落地）。
> - **阶段 2（治本）**：**8/8 已完成**（#8 领域端口声明 / #11 storage `IDb`/`IRepository` 抽象 / #15 `conformance` 去公开 API 且修复恒真断言 / #9 包提取 / #10 删依赖 / #14 RPC 注册表 + `withSession` + `compatibilityMode` 策略对象 / #12 `TerminalStudio` 拆为 `StudioModel`/`StudioView`/`StudioController` / #13 `WorkflowCoordinator` 拆协作对象 + `runAgentLoop` 拆四段管线。公开 API 全部保持兼容，行为零变化）。
> - **阶段 3（抛光）**：6 项中 **5 项已完成**（#17 解析器剥离 / #18 `Clock` 统一注入 / #21 文档同步 / #16 TUI 原子化重组 / #19 命名清理：评审重命名表已落地——`ExtensionInstaller`/`SessionRegistry`/`BranchExplorer`/`SlashCommandExecutor`/`TrustStoreFile`；名实不符已修——`tree.branch→addBranchMarker`、`remove→trash`、`getLoadedDocuments` 删除；全部兼容别名集中于 `agent-core/src/deprecations.ts` 并由测试守护；64 处出处式注释改写为契约描述。剩余：`Novel*` 业务前缀迁移与少量表外后缀，见 §2.13），**1 项受阻**（#20 `perFile` 覆盖率——被沙箱 safe-delete 守卫阻断而无法实测）。
>
> 本报告的 15 项原则裁定中，核心正确性缺陷（硬编码/mock、LSP、XSS、恒真断言）已被实质性修复；
> 结构性根因（包提取、巨型类拆分、RPC switch）属于阶段 2/3，部分已由新增守卫防止回潮，部分仍待重构。详见
> [`ARCHITECTURE.md` §5 Remediation Status & Known Debt](./ARCHITECTURE.md)。
>
> 已修复并由 CI 守护（防回潮）：
> - 生产路径静默使用假模型（`mock-test` / `faux` 已移入显式测试夹具）
> - `azure` / `bedrock` 静默映射到错误厂商 → 改为抛 `ProviderNotImplementedError`
> - `getDeltas` 跨后端 LSP 语义分歧 → 统一为 `id >= fromId` 闭区间
> - 沙箱 `roll()` 非法记号返回伪造随机数 → 改为抛 `InvalidDiceNotationError`
> - `escapeHtml` 三份不一致实现 → 收敛为单一实现并补齐 `'` `/` 转义
> - 空壳子类 / 等价别名 / 泄密 getter / 硬编码端口 → 已清理
> - 领域端口已声明（`packages/agent-core/src/ports/`：`SessionStore`/`ModelStreamer`/`Clock`/`IdGenerator`/`Logger`/`FileSystem`）
> - `storage` 提供 `IDb`/`IRepository` 抽象，`InkDb` 降级为 `node:sqlite` 实现之一
> - `conformance` 套件移出公开 API 至 `tests/`，`db.checkpoint()` 不再吞异常
> - TUI Markdown/Mermaid 解析器剥离为纯函数并补 colocated 测试
> - `TelemetryCollector`/`LiveSessionManager`/`SessionCompactor`/`runAgentLoop` 统一注入 `Clock`，`getStats`/`getMetrics` 为纯读
>
> 新增守卫测试：`tests/architecture-invariants.test.ts`（无静默假模型）、
> `tests/dependency-direction.test.ts`（依赖方向棘轮，见 §3 阶段 2 状态表）。
>
> **核心已治本，巨型类已沿职责边界拆分完毕**：`agent-core` 已不再是杂物抽屉——`src/tui/` 与 `src/rpc/` 已迁出（分别进入 `@inkpi/tui` 与 `@inkpi/server`），运行时依赖已收敛为 `@inkpi/protocol` / `@inkpi/ai` / `@inkpi/editor-core`，依赖方向棘轮 `BASELINE` 已清空。
> `WorkflowCoordinator`（原约 660 行）现为约 215 行装配门面，协作对象位于 `pipeline/`：`WorkflowExecutor` / `WorkflowStrategy`（替代 `compatibilityMode` 分支）/ `StageRegistry` / `GateRuleRegistry` / `RoleInvoker` / `TelemetryTracer` / `EventBus`，门禁检测（纯 `detectGateIssues`）与账本合并（纯 `mergeLedgers`）已单测。`runAgentLoop` 拆为 `turn/` 四段管线（`ContextTransformer`→`StreamInvoker`→`ToolDispatcher`→`TurnFinalizer`），两套工具并发策略合并为 `concurrency.ts` 的 `runWithConcurrency`。`TerminalStudio`（原约 494 行）拆为 `StudioModel`/`StudioView`/`StudioController` 三层 + 门面，公开字段以 getter 保持兼容。剩余债务为 P1/P2 硬编码项与 `perFile` 覆盖率（环境受阻），见 §5 Known Debt。

---

## 0. 总体裁决

| # | 原则 | 裁定 | 最硬的一条证据 |
|---|---|---|---|
| 1 | 硬编码与 mock | **严重违背** | `rpc/session-manager.ts:46` 生产路径静默回落到 `mock-test` 假模型 |
| 2 | 单一职责 (SRP) | **严重违背** | `pipeline/coordinator.ts` 单类 551 行 / 9 项职责 |
| 3 | 开闭原则 (OCP) | **违背** | `rpc/server.ts:212-452` 245 行 `switch` 方法分发 |
| 4 | 里氏替换 (LSP) | **严重违背** | `getDeltas` 在 sqlite 与 memory 后端语义不同，同一调用返回行数不同 |
| 5 | 接口隔离 (ISP) | **违背** | `ISessionBackend.search?()` 用可选成员伪造 ISP |
| 6 | 依赖倒置 (DIP) | **严重违背** | `agent-core/package.json` 运行时依赖 `@inkpi/tui` 与 `@inkpi/storage` |
| 7 | 关注点分离 | **严重违背** | 领域核心包内存在 `src/tui/`（648 行）与 `src/rpc/`（约 1200 行） |
| 8 | 端口与适配器 | **违背** | 端口接口（`FtsSearchEngine` 等）定义在基础设施包，方向反了 |
| 9 | 纯函数与副作用隔离 | **违背** | `reducer/session-reducer.ts:229` 自称纯函数却原地改写入参 |
| 10 | 原子设计 | **未落地** | `components/` 扁平 10 个文件，无 atoms/molecules/organisms 分层 |
| 11 | 组合优于继承 | **违背** | 抽象基类 `Component` + 4 个空壳子类 |
| 12 | 被动视图 / 展示模型 | **违背** | `TerminalStudio` 同时持有领域状态、视图状态与渲染 |
| 13 | 语义化命名 | **部分违背** | 19 个 `Manager/Handler/Data` 后缀 + 12 组别名 + 10 项名实不符 |
| 14 | 设计模式合理性 | **过度设计 + 用错** | 4 类别名指向同一个类；`DifferentialRenderer` 名不副实 |
| 15 | 可测试性 | **部分达成** | 聚合覆盖率达标但分支仅 80.11%（阈值 80.00%），`daemon.ts` 分支 52.8% |

**一句话结论**：这不是一个六边形架构，而是一个**分层命名良好的单体**——包名和目录名表达了架构意图，但依赖关系没有兑现它。`ARCHITECTURE.md` 的三条不变量全部与代码现状不符。

---

## 1. 三个结构性根因

大多数问题不是独立的，而是以下三条根因的派生。先解决根因，再谈细节。

### 根因 A：`agent-core` 不是领域核心，而是杂物抽屉

`packages/agent-core/package.json` 的运行时依赖：

```json
"dependencies": {
  "@inkpi/protocol": "workspace:*",
  "@inkpi/tui": "workspace:*",        // ← 表现层
  "@inkpi/ai": "workspace:*",         // ← 基础设施
  "@inkpi/editor-core": "workspace:*",
  "@inkpi/storage": "workspace:*",    // ← 基础设施
  "ws": "8.21.3"                      // ← 网络
}
```

领域核心依赖了**表现层 + 基础设施 + 网络库**。后果是可传递的：

- `packages/agent-core/src/index.ts:15` — `export * from './tui/index.js'`
- `packages/agent-core/src/tui/render.ts:5` — `export * from '@inkpi/tui'`（整个 UI 包无过滤再导出）

任何 `import '@inkpi/agent-core'` 的包——包括 headless 的 `server` 和 `evals`——都会传递性拉入 ANSI 渲染器和会写 `process.stdout` 的模块。

核心包内实际装了什么：

| 目录 | 行数 | 真实归属 |
|---|---|---|
| `src/rpc/` | ~1200 | 适配器层（`net.createServer`、`ws`、`JSON-RPC` 分发） |
| `src/tui/` | 648 | 表现层（ANSI、框线绘制、差分渲染） |
| `src/modes/print-mode.ts` | CLI 驱动（9 处 `process.stdout.write`） |
| `src/package-manager-cli.ts` | CLI |
| `src/package-manager/`、`trust/`、`skills/`、`clipboard/`、`sandbox/` | OS 基础设施（`fs`、`child_process`、`vm`） |

**真正与"领域状态机"相关的代码不到一半。**

> ✅ **此根因已在阶段 2 #9 / #10 中修复**：`src/tui/` 与 `src/rpc/` 已迁出 `agent-core`（分别进入 `@inkpi/tui` 与 `@inkpi/server`），运行时依赖收敛为 `protocol` / `ai` / `editor-core`，依赖方向棘轮 `BASELINE` 已清空。`agent-core` 不再是杂物抽屉（详见顶部整改状态与 §3 路线图）。

### 根因 B：抽象定义在了错误的一侧

`packages/agent-core/src/rpc/server.ts:12`：

```ts
import type { FtsSearchEngine, InkRepository, AppendOnlySessionJournal, JitMemoryRetriever } from '@inkpi/storage';
```

这四个**持久化端口定义在基础设施包里**，领域反过来向基础设施借用抽象。依赖倒置要求"抽象由内层声明、外层实现"，这里是反的。

配套问题：`storage` 包内**不存在任何 `IDb` / `IRepository` 抽象**。`packages/storage/src/db.ts:1,10` 直接绑定驱动：

```ts
import { DatabaseSync } from 'node:sqlite';
...
this.db = new DatabaseSync(dbPath);
```

所以 `ARCHITECTURE.md:64` 声称的"切换存储引擎无需触碰业务逻辑"不成立——连换 SQLite 驱动都要改 `db.ts`。

### 根因 C：假实现走的是生产路径

测试替身本该待在 `tests/`，这里它们注册进了生产注册表：

```ts
// packages/ai/src/providers.ts:1109
providerRegistry.set('faux', fauxProvider);
```

```ts
// packages/agent-core/src/rpc/session-manager.ts:46
this.defaultModel = defaultModel || getModelPreset('mock-test');
```

而 `daemon.ts:44` 正是以可选的 `defaultModel` 调用它。于是**不传模型配置启动守护进程，用户会和一个返回固定字符串 `'Faux test response'` 的假模型对话，且没有任何警告**。

---

## 2. 逐原则评判

### 2.1 硬编码与 mock — 严重违背

**P0 · 生产静默使用 mock 模型**
`packages/agent-core/src/rpc/session-manager.ts:46`
```ts
this.defaultModel = defaultModel || getModelPreset('mock-test');
```
`packages/ai/src/presets.ts:55-64` 的 `mock-test` 预设挂到 `faux` provider，返回固定文本。

**P0 · 厂商 provider 被静默映射到错误实现**
```ts
// packages/ai/src/providers.ts:1107-1108
providerRegistry.set('azure', openAiCompatibleProvider);
providerRegistry.set('bedrock', anthropicProvider);
```
`bedrock` 被映射到 Anthropic 公开 API，绕过 AWS SigV4 签名与 Bedrock 的 `invoke-with-response-stream` 路径。用户配置 `provider: 'bedrock'` 不报错，而是把请求静默发到 `api.anthropic.com`。**这比抛 `NotImplemented` 危险得多。**

**P0 · 领域函数返回伪造数据**
```ts
// packages/agent-core/src/sandbox/sandbox.ts:70
if (!match) return Math.floor(Math.random() * 20) + 1;
```
骰子记号非法时不报错，静默返回假的 1d20 结果。

**P1 · 事件投影写入编造的账本数据**
```ts
// packages/storage/src/journal.ts:266-274
stmt.run(`ledger_${this.sessionId}_${entry.id}`, this.sessionId,
  'State ledger update',      // 硬编码占位串
  JSON.stringify(ledger), 0, 0,  // tokens_before/after 固定为 0
  entry.timestamp);
```
编造数据进入 `session_compaction_records`，污染任何基于该表的成本统计。

**P1 · 适配器编造搜索结果**
```ts
// packages/session-backends/src/memory.ts:91-94（jsonl.ts:151-154 完全相同）
title: `Document ${docId}`,
snippet: snippet.trim(),
rank: -1,               // 写死的假 BM25 分值
orderIndex: idxOrder++
```

**P1 · SQLite 后端凭空创建默认工作区**
`packages/session-backends/src/sqlite.ts:63-81` 硬编码 `'ws_default'` / `'folder_default'` / `'Default Workspace'`，任何文档写入都隐式创建这些实体。

**P1 · 硬编码价格（无注入点）**
```ts
// packages/agent-core/src/telemetry/telemetry.ts:48-50
private modelInputCostPerM = 2.0;
private modelOutputCostPerM = 8.0;
private modelCacheReadCostPerM = 0.5;
```

**P1 · 伪造的 OTel traceId**
```ts
// packages/agent-core/src/telemetry/telemetry.ts:320
traceId: 'inkpi_trace_' + s.id,   // OTel 要求 32 位十六进制，导出到任何后端都会被拒
```

**P1 · Token 估算用固定系数伪造**
`packages/ai/src/prompt-caching.ts` 的 `Math.ceil(x.length * 0.7)` 出现 4 次（68、98、109、129）。中文字符/Token 比远低于 0.7，且无任何 tokenizer 注入点。同样的 `0.7` 在 `compaction/compaction.ts:47,50,51,104` 又出现 4 次——**同时用于触发判断和压缩后核算，误差会自证**。

**P2 · 其余硬编码清单**

| 位置 | 内容 |
|---|---|
| `rpc/daemon.ts:40,191` | 魔法端口 `41829` 出现两次，WS 端口 = TCP 端口 + 1 写死在默认参数 |
| `rpc/server.ts:101,123`、`tcp-transport.ts:42`、`rpc/client.ts:115` | 4 处硬编码 `127.0.0.1` |
| `sandbox/sandbox.ts:37,155,171` | 同一"沙箱"概念三个不同超时：3000 / 2000 / 1000 |
| `pipeline/coordinator.ts:528`、`loop.ts:79` | 硬编码 `thinkingBudget`；`loop.ts:79` 把 6 档思考级别全部塌缩成 2000 |
| `modes/print-mode.ts:63-98` | 10 个硬编码环境变量名 + provider 白名单写死在核心 |
| `storage/mutation-queue.ts:22,86` | 构造函数暴露 `defaultTtlMs = 15000`，唯一调用点却用字面量 `15000` 覆盖 |
| `catalog.ts:147-160` | 模型路由靠 `id.includes('mini')` 之类子串猜测 |
| `clipboard/system-clipboard.ts` | `timeout: 1000` 重复 8 次 |

> **值得肯定**：全仓库 `TODO|FIXME|HACK|XXX` 零命中。问题不以技术债标记的形式存在，而是以硬编码默认值的形式存在——**更隐蔽，也更该被揪出来**。

**重构方向**
1. 删除 `providers.ts:1109` 的 `faux` 注册，把 `mock-test` 预设移入 `packages/evals/` 或 `tests/fixtures/`；`session-manager.ts:46` 改为**缺失即抛错**。
2. `azure` / `bedrock` 要么实现，要么 `throw new ProviderNotImplementedError()`，禁止静默映射。
3. 建立 `packages/ai/src/pricing.ts` + `packages/ai/src/tokenizer.ts` 两个端口，价格与分词器注入而非硬编码。
4. 建 `config/` 目录集中所有策略常量（超时、阈值、端口、URL），按 `RuntimeConfig` 对象注入。
5. 沙箱 `roll()` 解析失败抛 `InvalidDiceNotationError`。

---

### 2.2 单一职责原则 (SRP) — 严重违背

| 类 / 函数 | 位置 | 规模 | 职责数 |
|---|---|---|---|
| `WorkflowCoordinator` | `pipeline/coordinator.ts` | ✅ 已拆分：约 215 行装配门面 + `WorkflowExecutor`/`StageRegistry`/`GateRuleRegistry`/`RoleInvoker`/`TelemetryTracer`/`EventBus` 协作对象（`workflow-executor.ts` 等），公开名与行为不变 | 拆分后单一职责 |
| `TerminalStudio` | `tui/studio.ts` | ✅ 已拆分：约 200 行门面 + `StudioModel`/`StudioView`/`StudioController` 三层（`studio-model.ts` 等），公开字段以 getter 委托 | 拆分后单一职责 |
| `InkRpcServer` | `rpc/server.ts:43-454` | 465 行 | 8 |
| `runAgentLoop` | `loop.ts` + `turn/` | ✅ 已拆分：`loop.ts` 为兼容出口，实现在 `turn/` 四段管线（`ContextTransformer`→`StreamInvoker`→`ToolDispatcher`→`TurnFinalizer`），并发策略统一为 `concurrency.ts` | 拆分后单一职责 |
| `SessionReportExporter` | `export/session-report-export.ts:96-285` | 299 行 | 8 |
| `InkPiDaemon` | `rpc/daemon.ts:29-221` | 221 行 | 7 |
| `ExtensionHost` | `extension-host.ts:28-243` | 216 行 | 7 |

**`WorkflowCoordinator` 职责枚举**
① 阶段注册表 ② 门禁规则注册表 ③ 事件总线（`:150` 直接 `console.error`） ④ 门禁检测（原 `detectPlotGateIssues` 与 `detectIssues` **两份重复实现**，**已收敛为单一纯 `detectGateIssues()`**，见 `pipeline/gate-detection.ts`） ⑤ 执行编排（`executeWorkflow` **单方法 256 行**） ⑥ LLM 调用与提示词装配 ⑦ 遗留兼容分支（`compatibilityMode === 'legacy-pipeline'` 在 **10 处**散布判断） ⑧ 状态账本合并（**已抽为纯 `mergeLedgers`/`mergeRecords`**，见 `pipeline/ledger-merge.ts`；含 5 处 `delete (result as any).characters` 运行时字段删除） ⑨ 遥测 span 生命周期。

**`TerminalStudio` 职责枚举**
编辑器状态 · 幽灵文本 · 斜杠命令注册表与执行 · **领域状态账本** · Agent 事件订阅与对话历史 · 焦点模式 · 资源列表 · 布局数学 · 三栏 ANSI 渲染 · 差分渲染 · 模态状态机 · 滚动状态 · toast 与墙钟过期 · 键盘输入路由。

它自己的注释（`studio.ts:59-60`）写着 *"Domain wording is supplied through labels so applications can adapt the surface"*，但 218/253/262/272/276/285 行的 fallback 全是硬编码中文领域文案（`📚 资源目录树`、`👤 活跃实体:`）。

**`SessionReportExporter` 尤为典型**：第 90-95 行注释称 *"The core renders protocol data only"*，紧跟着就是 40 行内嵌 `<style>`（128-164）和 9 行内嵌 `<script>`（184-192）。

**重构方向**
1. `WorkflowCoordinator` 拆为：`StageRegistry`（注册表）、`GateEvaluator`（门禁，策略模式）、`WorkflowExecutor`（编排，调前者）、`LedgerMerger`（纯函数，**已完成**）、`TelemetryTracer`（装饰器）。`detectPlotGateIssues` / `detectIssues` 合并为一个 `GateRule` 集合的 `evaluate()`（**已完成**：纯 `detectGateIssues()`）。
2. `runAgentLoop` 拆为：`ContextTransformer` → `StreamInvoker` → `ToolDispatcher`（含并发策略） → `TurnFinalizer`。工具并发策略已有两份实现（`loop.ts:376 executeSequential` 与 `tools.ts:113 executeBatch`），必须合并为一处。
3. `TerminalStudio` 按 §2.12 拆为 Model / View / Controller 三层。
4. `SessionReportExporter` 抽出 `ReportTemplate`（模板）与 `HtmlRenderer`（渲染器），CSS/JS 移到独立资源文件。

---

### 2.3 开闭原则 (OCP) — 违背

**反例 1：245 行 RPC 方法分发 switch**
`packages/agent-core/src/rpc/server.ts:212-452`，30+ 个 `case`。新增一个 RPC 方法必须修改这个类的源码。且每个方法都要处理两套名字（`editor.insert`/`editor.insertText`、`tree.switchBranch`/`tree.navigate`、`storage.searchFts`/`fts.search`……），遗留别名逻辑遍布。

**反例 2：10 处散布的兼容模式分支**
`pipeline/coordinator.ts` 的 `compatibilityMode === 'legacy-pipeline'` 在 251、295、310、328、332、335、347、359、399、433 行各判断一次；`runPipeline`（469-504）是**第二条完整执行路径**，内部还 `new WorkflowCoordinator(legacyOptions)` 递归构造自己。

**反例 3：model 路由靠改代码扩展**
`packages/ai/src/catalog.ts:147-160` 用 `id.includes('r1') || id.includes('3.7')` 选模型。新增厂商必须改源码。

**正例（应推广）**：`packages/agent-core/src/tools.ts` 的 `ToolRegistry` 与 `extension-host.ts` 的插件注册——通过 `register()` 扩展，符合 OCP。

**重构方向**
1. RPC 用**方法表 + 注册表**替代 switch：`registerMethod(name, handler)`，或按能力拆成多个 `RpcModule`（`EditorRpc`、`TreeRpc`、`StorageRpc`），各模块自己声明方法。遗留别名用一张 `LEGACY_ALIASES` 映射表在**入口一次性归一化**，不要散落在每个 case 里。
2. `compatibilityMode` 用**策略对象**替代条件分支：`interface WorkflowStrategy { execute(ctx): Promise<Result> }`，`ModernStrategy` / `LegacyStrategy`，构造时选一个。
3. 模型路由改为**能力声明驱动**：`ModelCatalogEntry` 上带 `capabilities: { reasoning: 'high'|'low', costTier }`，选择器按能力匹配而非子串猜测。

---

### 2.4 里氏替换原则 (LSP) — 严重违背

`ARCHITECTURE.md:49` 声称 `ISessionBackend` 有 *"full LSP conformance"*。**这条陈述不成立。**

**决定性证据：`getDeltas` 跨后端语义分歧**

契约 `packages/session-backends/src/types.ts:34`：`getDeltas(documentId: string, fromId?: number)`

三个实现过滤的是**不同字段、不同边界**：

```ts
// memory.ts:76 —— 按 delta id，闭区间
return list.filter((d) => (d.id || 0) >= fromId);

// jsonl.ts:124 —— 按 delta id，闭区间
if (fromId === undefined || (parsed.id || 0) >= fromId)

// sqlite.ts:121 → repository.ts:150 —— 按 created_at 时间戳，开区间
public getDeltas(documentId: string, afterTimestamp = 0): DocumentDelta[] {
  ... WHERE document_id = ? AND created_at > ?
```

同一调用 `getDeltas('doc_alpha', 2)`：memory/jsonl 返回 1 条，sqlite 返回 2 条。**任何按 `fromId` 做增量同步的调用方，切换后端后会丢数据或重复回放。**

根源是 `repository.ts:150` 形参名 `afterTimestamp` 与调用方实参语义（`fromId`）不符——**命名错误直接导致了行为错误**。

**"一致性测试"用弱化断言掩盖了分歧**
```ts
// tests/session-backends-conformance.test.ts:133-134
const filteredDeltas = await backend.getDeltas('doc_alpha', 2);
expect(filteredDeltas.length).toBeGreaterThanOrEqual(1);   // 1 条和 2 条都能通过
```

**`close()` 后置条件三方不同，且 memory 具有破坏性**

| 后端 | 行为 |
|---|---|
| memory (`memory.ts:31-36`) | **销毁全部数据**（`journals.clear()` / `snapshots.clear()` / `deltas.clear()`） |
| jsonl (`jsonl.ts:36-38`) | 空操作，数据完整保留在磁盘 |
| sqlite (`sqlite.ts:57-59`) | 关闭连接，重开可读回 |

契约只写了 `close(): Promise<void>`，未定义后置条件。消费方按"close 后可重新 initialize 读回"编写，在 memory 后端上会静默丢光全部会话。测试**从不校验 close 之后的行为**。

**其余分歧**

| 项 | 分歧 |
|---|---|
| `appendEntry` | sqlite (`sqlite.ts:96-98`) 忽略 `sessionId` 参数，走 `entry.sessionId`；memory/jsonl 用参数 |
| `capabilities.fts` | jsonl 声明 `fts: false`(`jsonl.ts:19`) 却实现了完整 `search`(`jsonl.ts:135`)；memory 声明 `fts: true`(`memory.ts:16`) 但只是 `String.includes` 子串扫描 |
| `FtsSearchResult.orderIndex` | sqlite 取文档排序号；memory/jsonl 取结果集行号 |
| 错误语义 | jsonl 静默跳过损坏行返回空数组（`jsonl.ts:72-74,160-162`）；sqlite 抛异常 |
| 并发语义 | jsonl 的读-改-写全量覆写存在丢失更新窗口；sqlite 用 `ON CONFLICT DO UPDATE` |
| 性能 | `jsonl.appendDelta` 为算 `nextId` 全量读回，O(n²)；memory 为 O(1) |
| 生命周期 | `memory.ts:25` 的 `initialized` 字段**声明后从未被读取**，是死状态 |
| I/O 调度 | jsonl 方法签名是 `Promise` 但内部 `fs.appendFileSync` 同步阻塞 |

**`packages/storage/src/conformance.ts` 测错了对象**
该文件 499 行，`storage/src/index.ts:9` 把它导出为公开 API，但它**从未 import `ISessionBackend`**（1-6 行 import 的全是 storage 自己的类）。更糟的是第 6 项是恒真断言：

```ts
// conformance.ts:481-489
public verifyWalCheckpoint(): ConformanceCheckResult {
  try { this.db.checkpoint(); return { passed: true, ... }; }
```
而 `db.ts:78-84` 的 `checkpoint()` 吞掉所有异常。因此该检查**在任何情况下都返回 `passed: true`**。

**重构方向**
1. **统一 `getDeltas` 语义**：契约明确规定"按自增 id 过滤，闭区间，`fromId === undefined` 返回全部"。`repository.ts:150` 形参改名为 `afterId`，SQL 改为 `WHERE document_id = ? AND id >= ?`。
2. **契约写出后置条件**（用 JSDoc 不变量）：`close()` 之后数据是否可读？`initialize()` 之前调用是否抛错？写入契约并让三个后端都遵守。
3. **建立真正的跨后端等价测试**：写一个参数化的 `backendConformanceSuite(backendFactory)`，三个后端跑**同一组**断言，并把 `>= 1` 这类弱断言改成精确值。
4. **删除 `conformance.ts` 或移入 `tests/`**，且不得从 `storage/index.ts` 导出。修复 `checkpoint()` 吞异常的问题。
5. `capabilities.fts` 与 `search` 的存在性做**静态绑定**：要么 `fts: true` 时 `search` 必选（拆接口），要么两者都删。

---

### 2.5 接口隔离原则 (ISP) — 违背

**典型：用可选成员伪造 ISP**
```ts
// packages/session-backends/src/types.ts:36-37
// Search (Optional depending on capabilities.fts)
search?(query: string, limit?: number): Promise<FtsSearchResult[]>;
```
本该拆成 `SessionBackend` + `SearchableBackend` 两个角色接口，退化成了一个带可选项的胖接口。后果是所有消费点被迫做存在性检查（`tests/session-backends-conformance.test.ts:137` 的 `if (backend.search)`），调用方无法静态保证搜索可用。

**`ExtensionAPI` 是 17 个方法的胖接口**
`packages/protocol/src/extensions.ts:131-154` 一个接口同时承担：工具注册、命令注册、快捷键注册、事件总线、上下文变换、UI 弹窗（`showSelectList`/`showInput`/`flashNotification`）、流水线钩子。所有成员必选，**无头环境下的实现也被迫提供 UI 弹窗方法**。

讽刺的是同文件 87-91 行已存在一个成员全可选的 `UIDelegate` 接口——**恰当的角色接口就在旁边，却没被组合进来**。

**索引签名让接口形同虚设**
```ts
// packages/protocol/src/extensions.ts:12-26
export interface AgentTool<TParams = any> {
  ...
  [key: string]: unknown;
}
```
同样出现在 `extensions.ts` 的 36、43、62、69、78、85、122 行。`[key: string]: unknown` 让任意对象都能结构化满足这些接口，编译器无法拒绝拼错字段——**接口隔离与类型安全同时失效**。

**契约中保留 5 个 deprecated 钩子**
`extensions.ts:112-121` 的 `PipelineHooks` 现役 3 个 + deprecated 5 个 + 索引签名。每个 deprecated 钩子的 ctx 都重复携带 5 个别名同义字段（`workspaceTitle`/`bookTitle`、`documentTitle`/`chapterTitle`/`sectionTitle`）。

**DTO 的双份字段**
```ts
// packages/protocol/src/storage.ts:197-208
currentText?: string;
/** @deprecated Use currentText. */
currentDraftText?: string[];
```
消费方被迫写 `query.currentText || query.currentDraftText || ''`——该模式在 `jit-memory.ts:59` 与 `:158` 重复两次。

**重构方向**
1. `ISessionBackend` 拆为 `SessionBackend`（生命周期 + 事件 + 快照）与 `SearchableBackend`（`search`），消费方按需取用。
2. `ExtensionAPI` 拆为 `ToolRegistry` + `CommandRegistry` + `EventBus` + `UIDelegate` + `PipelineHookRegistry`，`ExtensionHost` 组合它们。
3. **删除所有 `[key: string]: unknown` 索引签名**。若确需扩展点，用显式 `metadata?: Record<string, unknown>` 字段。
4. 设定 deprecated 的移除时间表，双份字段在新版本收敛为一份。

---

### 2.6 依赖倒置原则 (DIP) — 严重违背

证据见 §1 根因 A / B。补充几点：

**端口形同虚设：抽象有定义，默认值却硬编码为具体实现**
```ts
// packages/agent-core/src/types.ts:77
streamFn?: StreamFn;           // ← 端口在这里

// packages/agent-core/src/loop.ts:69（已核实）
const streamFn = options.streamFn || streamAi;   // ← 默认回落具体实现
```
领域循环无法在没有 `@inkpi/ai` 的情况下独立运行。**有接口不等于有倒置。**

**适配器向消费方泄漏基础设施句柄**
```ts
// packages/session-backends/src/sqlite.ts:128-134（不在 ISessionBackend 契约内）
public getRepository(): InkRepository { return this.repo; }
public getDb(): InkDb { return this.db; }
```
一旦消费方调用，抽象即告失效。更糟的是这处泄漏被测试正式加冕：
```ts
// tests/session-backends-conformance.test.ts:143-146
if (backend instanceof SqliteSessionBackend) {   // 一致性测试里出现 instanceof 具体类型
```

**`ai` 包此处值得肯定**：`packages/ai/package.json` 依赖只有 `@inkpi/protocol`，`src/` 内对厂商 SDK 的 import 零命中——**没有耦合任何厂商 SDK**。但缺传输端口：`providers.ts:418,692,892,1006` 四处直接调全局 `fetch`，无 `HttpClient` 注入点，测试只能 monkey-patch 全局。

**`protocol` 包值得肯定**：零运行时依赖、零 I/O，确为纯类型/纯函数层，与文档一致。

**重构方向**
1. 在 `agent-core` 内声明领域端口：`SessionStore`、`ModelStreamer`、`Clock`、`IdGenerator`、`Logger`、`FileSystem`。适配器包实现它们。
2. **禁止端口默认值回落具体适配器**。`streamFn` 必填，由组合根（composition root）注入。
3. 从 `agent-core/package.json` 删除 `@inkpi/tui`、`@inkpi/storage`、`@inkpi/ai`、`ws` 四个运行时依赖（改为 adapters 包依赖 agent-core）。
4. 删除 `sqlite.ts` 的 `getRepository()` / `getDb()`，测试中的 `instanceof` 分支一并删除。
5. 给 `ai` 包加 `HttpClient` 端口，全局 `fetch` 作为适配器层的默认实现注入。

---

### 2.7 关注点分离 — 严重违背

**视图层代码位于领域核心包内**（`packages/agent-core/src/tui/`，648 行），且被 `index.ts:15` 导出到公共 API。

`ARCHITECTURE.md:63` 明写 *"Pure state machines do not parse commands or handle RPC protocols"*，实际：
- `rpc/server.ts:207-452` 的 `dispatch()` 逐条解析并路由 JSON-RPC 方法——**字面违反**
- `tui/studio.ts:99` 视图类自己 `new SlashCommandRegistry()`，`:453-462` 执行命令解析与执行

**TUI 包把「计算帧」与「写 stdout」焊死，无端口**

| 位置 | 代码 |
|---|---|
| `tui/src/tui.ts:138` | `process.stdout.write(ANSI.CURSOR_HOME + output)` |
| `tui/src/tui.ts:62-65` | `process.stdin.setRawMode(true)` + 全局 `data` 监听 |
| `tui/src/tui.ts:71` | `process.stdout.on('resize', ...)` |
| `tui/src/tui.ts:39-40` | `cols: process.stdout.columns \|\| 80` |
| `tui/src/terminal-image.ts:12-18` | 读 `process.env.TERM` / `TERM_PROGRAM` / `KITTY_WINDOW_ID` |

后果直接体现在测试上：`tests/tui-package.test.ts:423-441` 调用 `tui.start()` 时，**测试进程真实向 stdout 灌 ANSI 序列**并真实注册 stdin 监听器。因为没有可注入的 `Writer` 端口，这是唯一能覆盖这些分支的办法。

**正例**：`packages/editor-core/**` 完全干净——零 I/O、零 ANSI、零 `console`。`HeadlessEditorState` / `GhostTextManager` 是纯内存状态机，可直接作为 Passive View 的 Model 层。

**重构方向**
1. 把 `agent-core/src/tui/`（studio + harness）迁出核心，进入 `packages/tui` 或新建 `@inkpi/studio`。
2. 把 `agent-core/src/rpc/` 迁到 `packages/server`，核心只留 `RpcMethodRegistry` 接口。
3. 给 `TUI` 注入 `Writer`（`write(s: string): void`）与 `TerminalSizeProvider`，默认实现用 `process.stdout`，测试注入 `StringWriter`。
4. `modes/print-mode.ts` 与 `package-manager-cli.ts` 迁入新建的 `packages/cli`。

---

### 2.8 端口与适配器 — 违背

见 §1 根因 B。**核心问题：抽象住在基础设施里。**

```ts
// packages/agent-core/src/rpc/server.ts:12（已核实）
import type { FtsSearchEngine, InkRepository, AppendOnlySessionJournal, JitMemoryRetriever } from '@inkpi/storage';
```

虽然这是 `import type`（不拖入运行时依赖图），但方向仍然是错的：领域向基础设施借用抽象。

另外，`packages/tui/package.json:18-19` 声明依赖 `@inkpi/protocol` 和 `@inkpi/editor-core`，但 `packages/tui/src/**` 中**一行都没 import 它们**——未使用依赖。而 `knip.json` 用 `"ignoreDependencies": ["@inkpi/*"]` 屏蔽了所有 workspace 内部依赖检查，所以 CI 发现不了。

**重构方向**
1. 建立 `packages/agent-core/src/ports/` 目录，集中声明所有领域端口。
2. `storage` 包提供 `IDb` / `IRepository` 抽象，`InkDb` 只是 `node:sqlite` 的一个实现。
3. 从 `knip.json` 移除 `@inkpi/*` 的全局忽略，改为按包精确配置。

---

### 2.9 纯函数与副作用隔离 — 违背

**P0 · 自称纯函数的 reducer 原地改写入参，且存在快照别名泄漏**

```ts
// packages/agent-core/src/reducer/session-reducer.ts:1-3（文件头）
/**
 * Pure Function SessionReducer ...
 */
// :229-246（已核实）
export function detectAndMarkInterruptedOperations(state: MaterializedSessionState) {
  for (const [id, op] of state.operations.entries()) {
    if (op.state === 'running' || op.state === 'pending') {
      op.state = 'interrupted';                 // ← 原地改写
      op.updatedAt = Date.now();                // ← 隐式时钟依赖
```

双重问题：① 与"纯函数"承诺矛盾；② `reduceSessionEntry`（60-67 行）只做 `new Map(state.operations)`——**浅拷贝，里面的 `OperationRecord` 对象引用与上一版快照共享**。因此修改 `op.state` 会同时改写到历史快照中，**破坏重放（replay）语义**。这是真实的正确性缺陷，不只是风格问题。

**P1 · getter 具有破坏性副作用**
```ts
// packages/agent-core/src/telemetry/telemetry.ts:273-279（已核实）
public getStats(): TelemetryStats { return this.endTurn(); }
public getMetrics(): TelemetryStats { return this.endTurn(); }
```
`endTurn()` 会设置 `this.endTime` 并 emit `turn_telemetry` 事件，即**终结当前 turn**。而 `rpc/server.ts:439,444` 把它们暴露为 `telemetry.getStats` / `telemetry.getMetrics`——**监控客户端每轮询一次就结束一次 turn**。`exportOpenTelemetryJson()`（`:305-306`）同样。

```ts
// packages/agent-core/src/rpc/session-manager.ts:88
public getSession(sessionId: string) {
  const session = this.sessions.get(sessionId);
  if (session) { session.lastActiveAt = Date.now(); }   // getter 改状态
```

**P1 · 导出操作永久删除源数据**
```ts
// packages/agent-core/src/export/session-share.ts:114-121
.filter((m) => {
  if (m.role === 'assistant' && Array.isArray(m.content)) {
    if (options.includeThinking === false) { m.content = m.content.filter(...); }  // ← 副作用
  }
  return true;    // ← 恒为 true：这不是 filter，是伪装成 filter 的 forEach
```

**P1 · 渲染函数有副作用，破坏 Passive View**
```ts
// packages/tui/src/components/editor.ts:367-375（已核实）
public render(context: RenderContext): string[] {
  if (this.cursorRow < this.scrollRow) { this.scrollRow = this.cursorRow; }  // ← 渲染改状态
// packages/tui/src/components/scroll-view.ts:49-51
  this.clampScroll(height);
```
渲染两次结果不同，无法做快照测试。

**P2 · 其余**

| 位置 | 问题 |
|---|---|
| `agent.ts:84`、`coordinator.ts:150`、`extension-host.ts:73,276`、`rpc/client.ts:70`、`ai/stream.ts:28,36` | 领域代码直接 `console.error`，无 logger 端口 |
| `modes/print-mode.ts:199` | 核心包内裸 ANSI：`process.stdout.write(\`\x1b[36m...\`)` |
| `package-manager.ts:31-32`、`trust/project-trust.ts:26-28` | 构造函数执行 `mkdirSync` / `readFileSync`，无法在测试中不碰磁盘地构造 |
| `tui/studio.ts:141-160` | 构造函数注册监听器并**丢弃返回的取消函数**，且类无 `dispose()` |
| `tui/studio.ts:299` | `renderScreen()` 内部读 `Date.now()`，同一状态不同时刻渲染不同输出 |
| `ai/providers.ts:224,1096-1109` | 模块级可变全局注册表，import 期副作用填充，测试间相互污染 |
| `ai/stream.ts:319-324` | `setTimeout(() => { runStream(); }, delay)` 是**未 await 的游离递归**；全程未使用 `options.signal`，重入期间 AbortSignal 不被响应 |

> **值得肯定**：全仓库模块级 `let`/`var`、单例、`globalThis` 污染**零命中**。所有模块级绑定均为 `const`。

**可测试性标准不统一**：`tree.ts:4-5` 与 `branch-what-if.ts:44-45` **已经**提供了 `idGenerator` / `clock` 注入口，`BranchSummarizer` 也接受；但 `SessionCompactor`、`TelemetryCollector`、`LiveSessionManager`、`runAgentLoop` 全都不接受。**同一包内两种截然不同的标准。**

**重构方向**
1. `detectAndMarkInterruptedOperations` 改为返回**新的** `MaterializedSessionState`；`reduceSessionEntry` 深拷贝 `OperationRecord`；`Date.now()` 由参数传入。
2. `getStats()` / `getMetrics()` 改为纯读；终结 turn 用显式的 `endTurn()` 命令方法。
3. `session-share.ts:114-121` 的 `.filter()` 改为无副作用的 `.map()` 投影。
4. `render()` 中的状态钳制改为**渲染前置的 `prepare()` 步骤**，或让 `render()` 读取而不写入（`computeScroll()` 返回建议值）。
5. 统一全包的 `Clock` / `IdGenerator` / `Logger` 注入口，**无默认值回落**（回落即等于不可注入）。
6. 引入 `AsyncAbort` 工具修复 `stream.ts` 的游离 Promise 递归。

---

### 2.10 原子设计 (Atomic Design) — 未落地

`packages/tui/src/components/` 是**扁平的 10 个文件**，无任何 `atoms/` / `molecules/` / `organisms/` 分层，无分层 barrel：

| 文件 | 行数 | 问题 |
|---|---|---|
| `box.ts` / `h-stack.ts` / `v-stack.ts` / `spacer.ts` | 各 2 行 | **空壳子类** |
| `scroll-view.ts` | 81 | |
| `select-list.ts` | 137 | |
| `markdown.ts` | 63 | **内含 Markdown 解析器** |
| `thinking-accordion.ts` | 96 | |
| `editor.ts` | 434 | 内含 buffer + undo/redo + kill-ring + 补全状态机 |

**空壳子类**（已核实）：
```ts
// packages/tui/src/components/box.ts:1-2
import { BoxComponent } from '../layout.js';
export class Box extends BoxComponent {}
```
四个零体类，只为换名字。它们还被 `vitest.config.ts:30-33` 明确排除出覆盖率统计，而测试专门实例化一次来刷覆盖行（`tests/tui-package.test.ts:118-121`：`expect(new CompBox({ title: 't' })).toBeDefined();`）——**测试的唯一目的是给空壳类刷覆盖行**。

**同一布局原语的两套并行实现**
- 类式：`layout.ts:77 HStackComponent`、`layout.ts:128 VStackComponent`、`components/scroll-view.ts:14`
- 函数式：`render.ts:181 layoutHStack()`、`render.ts:170 layoutVStack()`、`render.ts:199 renderScrollView()`

三对重复算法。维护者改布局规则必须改两处。

**越级依赖**：无。`components/*` 只 import `../layout.js`、`../render.js`、`../keys.js`、`../width.js`，全部向下。包级依赖也无环。**TUI 包内部依赖方向是健康的**——问题在包与包之间（见 §2.6）。

**重构方向**
1. 建立 `atoms/`（`Box`、`Text`、`Spacer`、`Divider`）、`molecules/`（`SelectList`、`ScrollView`、`ThinkingAccordion`、`Markdown`）、`organisms/`（`Editor`、`Studio`）。
2. **删除 4 个空壳子类**，并从 `vitest.config.ts` 移除对应 exclude。
3. 统一布局原语为一套（建议保留函数式，组合性更好），类式改为函数式的薄封装或直接删除。
4. `markdown.ts` 与 `mermaid.ts` 的**解析逻辑抽到 `packages/tui/src/parsers/`**，渲染器只消费 AST——这样解析可脱离 ANSI 单独测试。

---

### 2.11 组合优于继承 — 违背

**抽象基类反模式**
```ts
// packages/tui/src/layout.ts:21-24（已核实）
export abstract class Component {
  public flex = 1;
  public abstract render(context: RenderContext): string[];
}
```

三个具体问题：

1. **基类唯一字段是死代码。** `Component.flex` 在 `layout.ts:37` 被写入，但布局引擎读的是 `children` 数组里**包装对象**的 `flex`（`layout.ts:94,104,148,160` 的 `c.flex`），**从不读 `child.component.flex`**。该字段全仓库无读取点。

2. **基类在容器里被 `instanceof` 反向类型切换，多态形同虚设：**
```ts
// packages/tui/src/layout.ts:144,147,157
(c.component instanceof SpacerComponent ? c.component.size : 0)
this.children.filter((c) => ... !(c.component instanceof SpacerComponent))
} else if (child.component instanceof SpacerComponent) {
```
容器对具体子类做类型判断，而不是让组件自己声明 `getIntrinsicSize()`。这正是继承 + 向下转型的典型症状，**用一个 `size()` 契约就能消除**。

3. **继承被用作能力探测的 hack：**
```ts
// packages/tui/src/tui.ts:102-103
if ('handleKey' in activeOverlay.component && typeof (activeOverlay.component as any).handleKey === 'function')
```
基类没有声明 `handleKey`，于是运行时用 `any` 强转做鸭子类型——**继承没有提供任何契约保障**。

**无意义的空壳继承（领域层）**
```ts
// packages/agent-core/src/queues.ts:39-40（已核实）
export class SteeringQueue extends MessageQueue {}
export class FollowUpQueue extends MessageQueue {}
```
两个空体子类，不增加成员、不覆写方法。真正的行为差异**不在子类里，而在调用方传的 mode 参数里**：
```ts
// loop.ts:39   steeringQueue.drain(options.steeringMode || 'all')
// loop.ts:351  followUpQueue.drain(options.followUpMode || 'one-at-a-time')
```
`SteeringQueue` 完全可以被当 `'one-at-a-time'` 排空，反之亦然，**类型系统不提供任何保证**。

> **明确说明**：全仓库**没有子类方法覆写**，因此不存在经典的"子类改行为"式 LSP 违规（这一项在继承维度上是干净的）。问题在于继承被用来做命名和类型区分，而非行为扩展。

**重构方向**
1. 定义 `Renderer = (ctx: RenderContext) => string[]` 函数类型，组件改为**工厂函数**返回渲染器。
2. 用 `interface LayoutNode { render(ctx): string[]; intrinsicSize?(axis): number }` 替代抽象基类，`instanceof SpacerComponent` 改为调用 `intrinsicSize()`。
3. `handleKey` 声明为可选接口 `KeyHandler { handleKey(k: KeyEvent): boolean }`，消除 `any` 强转。
4. `SteeringQueue` / `FollowUpQueue` 删除，改为 `new MessageQueue('all')` 与 `new MessageQueue('one-at-a-time')`，或提供两个命名工厂函数 `createSteeringQueue()` / `createFollowUpQueue()`。

---

### 2.12 被动视图与展示模型 — 违背

`TerminalStudio`（`agent-core/src/tui/studio.ts:62-468`）**不存在 ViewModel/Presenter 边界**：

```ts
public editor: HeadlessEditorState;          // 编辑器状态
public stateLedger: StateLedger = {...};     // ← 领域账本
public resources: StudioResourceItem[];      // ← 领域资源
public focusMode: StudioFocusMode;           // 视图状态
public outlineScrollOffset = 0;              // 视图状态
public activeModal: 'selectList' | 'input' | null = null;
```

领域状态、编辑器状态、视图状态、渲染全部在一个类里。外部（测试）只能通过 `studio.stateLedger`、`studio.activeSelectIndex`、`studio.outlineScrollOffset` 这类**内部字段**做断言——这正是缺失展示模型的症状。

**视图层执行命令解析**：`studio.ts:453-462` 视图类自己 `new SlashCommandRegistry()` 并 `execute()`。

**视图层内联键码解析，绕过已有的 `parseKey()`**
```ts
// studio.ts:409-421
if (input === '\u001b[A' || trimmed === 'UP' || trimmed === 'k') { ... }
```
`@inkpi/tui` 已导出正式的 `parseKey()`（`keys.ts:18`）和 40+ 条规范化序列。Studio 完全绕过它，自己写了一遍原始转义序列 + 三种别名。**这是第二套键盘模型。**

**`DifferentialRenderer` 名不副实**
```ts
// packages/tui/src/render.ts:154-158
return {
  changedLines: changed,
  output: newScreenText,     // ← 整屏文本
  diffAnsi: diffSegments.join(''),
  isDiff: changed > 0
};
```
算了 diff，但两个调用点（`tui.ts:134-141`、`studio.ts:395-402`）**都丢弃 `diffAnsi` 只用 `output`**。`diffAnsi` 的唯一消费者是测试（`tests/tui-package.test.ts:78`）。

**i18n 接缝只做了一半**：`StudioLabels` 有 25 个可注入字段，但 `studio.ts:186,197` 的 `切换至: ${...}` **不可覆盖**；而 `handleInput()` 的返回值又硬编码英文（`:411 'Selection up'`、`:431 'Ghost text accepted'`、`:466 'Text inserted'`）。同一类中英混排，且这些字符串直接被测试断言（`tests/tui-studio.test.ts:64,72,77`）——**把领域测试绑死在英文 UI 文案上**。

**重构方向**
1. 拆三层：
   - `StudioModel`：持有 `StateLedger` / `resources` / `dialogue` / `editor`，暴露 `subscribe()`，零 ANSI
   - `StudioView`：**纯函数** `render(model: StudioViewModel): string[]`
   - `StudioController`：`handleInput(key: KeyEvent): Command`，把输入翻译成对 Model 的命令
2. 所有输出文案进入 `labels`，不可覆盖的硬编码（`studio.ts:186,197,411,431,466`）全部改为可注入。
3. Studio 改用 `@inkpi/tui` 的 `parseKey()`，删除自己的转义序列字面量。
4. `DifferentialRenderer` 要么真用 diff 输出，要么改名为 `ScreenBuffer`。

---

### 2.13 语义化命名 — 部分违背

**空泛后缀统计**（仅 `agent-core`，声明处计数 19 个）

| 后缀 | 数量 | 实例 |
|---|---|---|
| `Manager` | 6 | `BranchManager`、`SessionShareManager`、`ExtensionPackageManager`、`SandboxManager`、`LiveSessionManager`、`ProjectTrustManager` |
| `Handler` | 3 | `SlashCommandHandler`、`PlotGateHandler`、`getStateHandler` |
| `Runner` | 3 | `ExtensionRunner`、`ISandboxRunner`、`ClipboardCommandRunner` |
| `Data` | 2 | `TrustStoreData`、`sessionData` |
| 其他 | 5 | `WhatIfBranchInfo`、`StudioResourceItem`、`TerminalHarness`、`compaction/utils.ts`、`safeHelpers` |

`Service` / `Base` / `Common` / `Wrapper` **零命中**（这一项干净）。

**别名爆炸：约 12 组**
```ts
// packages/agent-core/src/pipeline/coordinator.ts:660-667 —— 4 个别名指向同一个类
export { NovelCollaborativePipeline, CollaborativePipeline, PipelineCoordinator, WorkflowCoordinator }
// branch-what-if.ts:322  export const StoryBranchManager = BranchManager;
// agent.ts:229           export const AgentEngine = Agent;
// tui/studio.ts:470      export const TuiStudio = TerminalStudio;
// tui/terminal-harness.ts:170  export const TerminalWriterHarness = TerminalHarness;  // @deprecated
```

**名实不符（10 项，最严重的三项）**

1. **`tree.ts:86 fork()` 不分叉**
```ts
public fork(fromNodeId: string): string { return this.selectLeaf(fromNodeId); }
```
注释（70-76 行）自己承认 *"This method does not clone or persist a separate session"*。而 `slash-commands.ts:174-175` 调用后向用户报告：`🌿 已从节点 ${fromId} 成功分叉出新推演分支！`——**用户被告知创建了分支，实际只是移动了指针**。

2. **`telemetry.ts:273 getStats()` / `getMetrics()` 是写操作**（见 §2.9）

3. **`slash-commands.ts:66 isSlashCommand()` 不检查命令是否存在**
```ts
public isSlashCommand(input: string): boolean { return input.trim().startsWith('/'); }
```
`tui/studio.ts:453` 用它决定走命令分支，随后 `execute()` 返回"未知指令"。

其余：`tree.ts:90 branch()` 不分支（是追加消息，与 `fork` 语义整体互换）、`extension-host.ts:295 getLoadedDocuments()` 返回模块、`package-manager.ts:91 remove()` 不删除（移入 `.trash`，无 `purge`）、`reducer/session-reducer.ts` 自称纯函数。

**业务领域词污染"通用"核心**：`Novel*`（小说）前缀出现在一个自称 *"100% 动态化，零业务/人设偏见"*（`roles.ts:19`）、*"具备 0 业务偏见"*（`coordinator.ts:89`）的包里。

**注释以出处代替设计意图**：至少 10 处注释写作 *"1:1 对标 repos/pi X"*（`journal.ts:31`、`catalog.ts:101`、`leases.ts:14`、`conformance.ts:24`、`prompt-caching.ts:27` 等）。注释描述的是出处而非契约，读者无法从中得知行为承诺。

**重构方向（落地状态，P3-19）**
1. 重命名表：✅ 已落地——`ExtensionPackageManager` → `ExtensionInstaller`；`LiveSessionManager` → `SessionRegistry`；`BranchManager` → `BranchExplorer`；`SlashCommandHandler` → `SlashCommandExecutor`；`TrustStoreData` → `TrustStoreFile`（后两项名称微调：前者补回 Slash 语境，后者如实描述"磁盘信任存储文件"的形状，`TrustedProjectList` 无法涵盖 `lastUpdated` 字段）。
2. 别名集中化：✅ 已落地——全部兼容别名（`AgentEngine`/`StoryBranchManager`/`ExtensionPackageManager`/`LiveSessionManager`/`NovelCollaborativePipeline`/`CollaborativePipeline`/`PipelineCoordinator`/`SlashCommandHandler`/`TrustStoreData`）集中到 **`agent-core/src/deprecations.ts`** 一处，统一 `@deprecated` + 移除版本 v1.0，`tests/deprecations.test.ts` 守护别名与权威名同址。包外使用为零，无破坏。
3. 名实不符：✅ 已落地——`fork()` 早前改名 `selectLeaf()`；`tree.branch()` 改名 `addBranchMarker()`（弃用别名保留，RPC 线上方法名不变）；`package-manager.remove()` 改名 `trash()`（如实表达"移入隔离区"）；`extension-host.getLoadedDocuments()` 删除（`getLoadedModules()` 为权威名）。
4. `Novel*` 业务词迁移：⏸ 未做——属打包级改动（新建领域包），超出命名清理范围，记录于 ARCHITECTURE.md Known Debt。
5. 注释契约化：✅ 已落地——全仓 64 处 `(1:1 对标 …)` 出处式注释全部改写为契约/行为描述。

---

### 2.14 设计模式合理性 — 过度设计与用错并存

**已正确使用**
- **注册表模式**：`ToolRegistry`（`tools.ts`）、`ExtensionHost` 的插件注册 —— 符合 OCP
- **依赖注入**：`system-clipboard.ts:32` 的 `commandRunner` 可注入，测试注入 stub（`tests/system-clipboard.test.ts:33-37`）——**本仓库 DI 做得最好的地方**
- **策略模式（雏形）**：`ISessionBackend` 的多实现

**过度设计**
- 4 类别名指向同一个类（`coordinator.ts:660-667`）
- 4 个空壳子类（`box.ts` / `h-stack.ts` / `v-stack.ts` / `spacer.ts`）
- 2 个空体队列子类（`queues.ts:39-40`）
- `leases.ts:95-101` 的 `acquire`/`acquireLease`、`release`/`releaseLease` **两两等价**，公开 API 面无谓翻倍
- 三套并行布局原语（类式 / 函数式 / Studio 内联）

**用错或名不副实**
- `DifferentialRenderer`：算了 diff 但从不使用（§2.12）
- `ModelCatalogManager`（`catalog.ts:103`）：类名不体现职责，实际负责注册、查询、过滤、路由推荐、刷新五项
- `Component` 抽象基类：唯一字段是死代码，且被 `instanceof` 反向切换（§2.11）

**遗漏的模式（本该用而没用）**
- RPC 的 245 行 switch → 应用**命令模式 + 注册表**
- `compatibilityMode` 的 10 处条件分支 → 应用**策略模式**
- `escapeHtml` 有**三份不一致的实现**：`session-report-export.ts:292-299`（转义 `'`）、`session-share.ts:229-237`（转义 `'`）、`session-export.ts:154-160`（**不转义 `'`**）。第三份在单引号包裹的属性上下文中存在 XSS 面，且修复必须同步三处 → 应抽为单一工具函数
- `rpc/daemon.ts` 中"取 session / 找不到就抛错"的样板**重复 9 次**（86-89、100-103、110-112、128-129、135-136、142-143、149-150、156-157、170-171）→ 应用**模板方法或中间件**

**重构方向**
1. 删除所有空壳类与等价方法别名。
2. RPC 改为注册表 + 方法表；`daemon.ts` 的样板抽为 `withSession(handler)` 高阶函数。
3. `escapeHtml` 收敛为单一实现并补齐 `'` 与 `/` 转义。
4. `DifferentialRenderer` 要么兑现契约要么改名。

---

### 2.15 可测试性 — 部分达成

**达成的部分**
- 67 个测试文件，`agent-core` 的 `clipboard`、`tree`、`branch-what-if` 等模块有可注入的 `Clock` / `IdGenerator` / `commandRunner`
- `MemoryTransport.createPair()`（`tests/rpc-remote-transports.test.ts:28`）为 RPC 测试提供了正确的内存隔离
- `ARCHITECTURE.md:66` 声明的 ≥85% 行 / ≥80% 分支**确实配置在 `vitest.config.ts:13-18`** 并被 CI 执行

**未达成的部分**

**(a) 覆盖率是"聚合达标、局部失守"**

实测（从 `coverage/coverage-final.json` 计算）：

```
TOTAL  statements 91.74%   branches 80.11%   （阈值 85 / 80）
```

**分支覆盖率距阈值仅 0.11 个百分点**，而这个"刚好过线"的组合掩盖了下面的单文件实况：

| 文件 | 语句 | 分支 |
|---|---|---|
| `server/src/daemon.ts` | 76.2% | **52.8%** |
| `server/src/sessions.ts` | 84.6% | **57.1%** |
| `storage/src/journal.ts` | 90.7% | **65.8%** |
| `session-backends/src/jsonl.ts` | 88.2% | **67.5%** |
| `ai/src/providers.ts` | 81.0% | **68.9%** |
| `storage/src/conformance.ts` | 80.5% | **69.2%** |
| `agent-core/src/modes/print-mode.ts` | 79.2% | **71.2%** |
| `tui/src/components/editor.ts` | 89.0% | **72.1%** |
| `agent-core/src/loop.ts` | 79.1% | 76.7% |

原因：未启用 `perFile: true`，阈值只对全仓库聚合生效；且 `vitest.config.ts:25-35` 的 exclude 白名单摘掉了 `packages/protocol/**`、`**/types.ts`、四个 TUI 空壳组件、`system-clipboard.ts`、`models.generated.ts`。

**(b) 测试全集中，零 colocated**
`tests/` 下 66 个 `.test.ts`，`packages/**/*.test.ts` 为 **0**。`vitest.config.ts:9` 配置了 colocated 模式但从未使用。后果是 `packages/tui/src/components/editor.ts`（434 行）没有伴随测试，只能靠一个大杂烩 `it()` 覆盖，其中大量是「调用后不断言」的纯覆盖刷行。

**(c) 测试依赖真实基础设施**

| 类型 | 证据 |
|---|---|
| 真实 TCP 端口 | `tests/daemon-rpc-e2e.test.ts:5` **硬编码 `TEST_PORT = 42831`**（同仓库 `rpc-remote-transports.test.ts:90` 用的是 `listenTcp(0)` 临时端口——两种做法并存说明是遗漏） |
| 真实磁盘 | `print-mode.test.ts`、`project-trust.test.ts`、`skills.test.ts`、`package-manager.test.ts` 等 12+ 处直接 `fs.writeFileSync` 到 `tmpdir` |
| 真实子进程 | `tests/cli-bin.test.ts:9,14,23` 三次 `execSync`；`pi-six-pillars-integration.test.ts:437-470` **执行 git 并断言工作区干净** |
| 真实定时器 | 5 处 `setTimeout` 等待；全仓库 `vi.useFakeTimers` 命中数 **0** |
| 真实 SQLite | 24 处 `new InkDb(':memory:')` 出现在**领域/用例层**测试中 |

**(d) 测试不被类型检查**
`tsconfig.json` 的 `references` 只列 10 个 `packages/*`，**`tests/` 不在任何 TS project 中**。证据：`tests/tui-harness.test.ts:59` 传 `typography: 'chinese-novel'`，而签名（`:15`）只允许 `'chinese' | 'western' | 'none'` 或对象——**这是类型错误，但 CI 全绿**。

**(e) 断言实现细节，把 bug 固化成契约**
```ts
// tests/tui-package.test.ts:78 —— 断言具体 ANSI 字节
expect(frameShrink.diffAnsi).toContain('\x1b[2;1H\x1b[2K');
// tests/tui-cursor-overlay.test.ts:59 —— 断言具体列号
expect(cursor?.col).toBe(visibleWidth('第二行 输入正文: 林玄手持') + 1);
// tests/tui-studio.test.ts:123-125 —— 断言 §2.12 指出的硬编码英文文案
expect(emptyScreen).toContain('no entities');
```
最后一条最危险：**测试正在把缺陷固化成契约**。

**重构方向**
1. 启用 `perFile: true`，或至少为 `daemon.ts` / `sessions.ts` / `journal.ts` / `providers.ts` 设单独门槛。同时收紧 exclude 白名单。
2. `tests/daemon-rpc-e2e.test.ts:5` 改用 `listenTcp(0)` 动态端口。
3. 把 `cli-bin.test.ts` 与 `pi-six-pillars-integration.test.ts` 的 `execSync` 冒烟测试**从 vitest 套件中拆出**（它们是构建验证，不是单元测试）。
4. **新增 `tests/tsconfig.json`，把 `tests/` 纳入 `tsc -b`**——否则类型错误永远不会被发现。
5. 快照测试用 `vi.useFakeTimers()` + `vi.setSystemTime()` 替换真实 `setTimeout`。
6. 领域/用例层测试改用 `ISessionBackend` 的内存实现或 repository stub，而非真实 SQLite。
7. 把描述性断言（`toContain('Resources')`）改为对 **ViewModel 结构**的断言，删除对 ANSI 字节和列号的断言。

---

## 3. 重构路线图

按"先止血、再治本、后抛光"排序。每一步都应可独立合并且不破坏 CI。

### 阶段 1 · 止血（1-2 周，全部为低风险局部修改）

**状态：7 项中 6 项完成，1 项部分完成。**

| # | 动作 | 消除的问题 | 状态 |
|---|---|---|---|
| 1 | `session-manager.ts:46` 缺失模型即抛错；从 `providers.ts:1109` 移除 `faux` 注册；`mock-test` 预设移入 `tests/fixtures/` | 生产静默用假模型 | ✅ 已完成（`installTestDoubles()` 显式装配） |
| 2 | `azure` / `bedrock` 改抛 `ProviderNotImplementedError` | 静默错误映射 | ✅ 已完成 |
| 3 | `sandbox.ts:70` 解析失败抛错 | 领域函数返回伪造数据 | ✅ 已完成（`InvalidDiceNotationError`） |
| 4 | 统一 `getDeltas` 语义：`repository.ts:150` 形参改名 `afterId`，SQL 改 `id >= ?` | LSP 数据丢失缺陷 | ✅ 已完成（另增 `getDeltasSince` / `deleteDeltasBefore`） |
| 5 | `escapeHtml` 三份收敛为一份，补齐 `'` 转义 | XSS 面 + 三处同步 | ✅ 已完成（`export/html.ts`，另补 `/`） |
| 6 | 删除 4 个 TUI 空壳子类 + 2 个空体队列子类 + `leases.ts` 等价别名 | 过度设计 | ✅ 已完成（TUI 4 类改为**再导出别名**，保留公开 API 的同时消除空壳子类） |
| 7 | `tests/` 纳入 `tsc -b`；`daemon-rpc-e2e.test.ts` 改用 `listenTcp(0)` | 类型检查盲区 + 端口冲突 | ✅ 已完成（`tests/` 已纳入 `tsc -b`，动态端口已落地） |

### 阶段 2 · 治本（3-6 周，结构性重构）

**状态：8 项中 3 项已完成、5 项未开始。** 已新增 `tests/dependency-direction.test.ts` 作为**棘轮守卫**：
它把当前 6 个依赖违规文件登记为基线，CI 保持绿灯，但任何新增违规立即失败，
且基线只许变小不许变大。这为第 8/9/10 项提供了可度量的收敛路径。

| # | 动作 | 消除的问题 | 状态 |
|---|---|---|---|
| 8 | 建 `agent-core/src/ports/`：`SessionStore`、`ModelStreamer`、`Clock`、`IdGenerator`、`Logger`、`FileSystem` | DIP | ✅ 已完成（`ports/index.ts` 已声明六类端口；`LiveSessionManager implements SessionStore`，`types.ts` 的 `streamFn` 改用 `ModelStreamer`） |
| 9 | 从 `agent-core` 迁出 `src/tui/` → `@inkpi/tui`，`src/rpc/`（daemon/server/client/transports）→ `@inkpi/server`，CLI 留在 `bin/`·`scripts/` | 关注点分离 | ✅ 已完成（`@inkpi/server` 与 `@inkpi/tui` 原已是桩，覆盖为完整实现并清空棘轮基线；`LiveSessionManager` 作为领域对象留在 `agent-core` 并由 `server` 再导出，依赖单向 `server→core`，断裂了原 `tui↔agent-core↔server` 循环图） |
| 10 | 从 `agent-core/package.json` 删除 `tui` / `storage` / `ws` 依赖（保留被允许的 `@inkpi/ai`） | 依赖倒置 | ✅ 已完成（现仅依赖 `protocol` / `ai` / `editor-core`；棘轮 `BASELINE` 已清空） |
| 11 | `storage` 提供 `IDb` / `IRepository` 抽象，`InkDb` 降级为 `node:sqlite` 的一个实现 | 存储可插拔 | ✅ 已完成（`ports.ts` 定义 `IDb`/`IRepository`，`InkDb`/`InkRepository` 分别实现） |
| 12 | `TerminalStudio` 拆为 `StudioModel` / `StudioView` / `StudioController` | 被动视图 | ✅ 已完成（`@inkpi/tui` 内拆为 `studio-model.ts`（全部状态与迁移）/ `studio-view.ts`（纯渲染 + 差分渲染器）/ `studio-controller.ts`（输入→状态迁移意图），`studio.ts` 为组装门面；原公开字段以 getter 委托 Model，公开 API 与行为零变化；`tui-studio.test.ts` 等全绿） |
| 13 | `WorkflowCoordinator` 拆为 5 个协作对象；`runAgentLoop` 拆为 4 段管线 | SRP | ✅ 已完成（`WorkflowCoordinator`（约 215 行门面）+ `pipeline/` 协作对象：`WorkflowExecutor`/`StageRegistry`/`GateRuleRegistry`/`RoleInvoker`/`TelemetryTracer`/`EventBus` + 纯 `detectGateIssues`/`mergeLedgers`；`runAgentLoop` 为兼容出口，实现在 `turn/` 四段管线：`TurnContext`→`ContextTransformer`→`StreamInvoker`→`ToolDispatcher`→`TurnFinalizer`（`AgentLoopRunner` 编排）；两套工具并发策略合并为 `concurrency.ts`；新增 `pipeline-workflow-strategy` / `turn-stages` / `concurrency` 单测） |
| 14 | RPC 改注册表 + `withSession()` 高阶函数；`compatibilityMode` 改策略对象 | OCP | ✅ 已完成（`@inkpi/server` RPC 层用 `registerMethod()` 注册表，`InkPiDaemon` 的 9 处样板抽为 `withSession()`；`pipeline/workflow-strategy.ts` 提供 `genericWorkflowStrategy`/`legacyPipelineWorkflowStrategy` + `resolveWorkflowStrategy()`，`WorkflowCoordinator` 内 10 处 `compatibilityMode === 'legacy-pipeline'` 分支全部消除，选项面不再暴露 `compatibilityMode`） |
| 15 | 建立跨后端参数化一致性套件，删除 `storage/conformance.ts` 或移入 `tests/` | LSP 验证 | ✅ 已完成（`conformance.ts` 移入 `tests/storage-conformance-suite.ts` 并去公开导出；`db.checkpoint()` 诚实重抛，原恒真断言改为断言 `false`） |

### 阶段 3 · 抛光（持续）

**状态：6 项中 5 项完成（#16/#17/#18/#19/#21）、1 项受阻（#20，环境性）。**

| # | 动作 | 状态 |
|---|---|---|
| 16 | TUI 组件按 `atoms/` / `molecules/` / `organisms/` 重组；公开 API（含 `Box`/`HStack`/`VStack`/`Spacer` 再导出别名）保持不变 | ✅ 已完成（`components/` 重组为 `atoms/`(`Box`/`HStack`/`VStack`/`Spacer`)、`molecules/`(`SelectList`/`ScrollView`/`ThinkingAccordion`/`Markdown`)、`organisms/`(`Editor`)，各含 barrel；`tsc -b` 与 TUI 测试全绿） |
| 17 | 解析器（Markdown / Mermaid）从渲染器剥离 | ✅ 已完成（`parsers/markdown-parser.ts` / `parsers/mermaid-parser.ts` 纯函数化 + colocated 测试） |
| 18 | 全包统一 `Clock` / `IdGenerator` 注入，删除默认值回落 | ✅ 已完成（`TelemetryCollector`/`LiveSessionManager`/`SessionCompactor`/`runAgentLoop` 注入 `Clock`；`tree`/`branch-what-if` 早先已注入） |
| 19 | 重命名 19 个空泛后缀标识符；删除 12 组别名；修正 10 项名实不符 | ✅ 基本完成（评审重命名表落地：`ExtensionPackageManager→ExtensionInstaller`、`LiveSessionManager→SessionRegistry`、`BranchManager→BranchExplorer`、`SlashCommandHandler→SlashCommandExecutor`、`TrustStoreData→TrustStoreFile`；名实不符修正：`tree.branch→addBranchMarker`（弃用别名保留）、`remove→trash`、`getLoadedDocuments` 删除（`getLoadedExtensions` 同步标弃用）；全部兼容别名集中于 `agent-core/src/deprecations.ts`，统一 `@deprecated` + 移除版本 v1.0，`tests/deprecations.test.ts` 守护；64 处出处式注释改写为契约描述。剩余（记录于 ARCHITECTURE.md Known Debt）：`Novel*` 业务前缀迁移属打包级改动、少量表外后缀、`@inkpi/tui` 内 `TuiStudio` 别名） |
| 20 | 启用 `perFile: true` 覆盖率；测试改为断言 ViewModel 而非 ANSI 字节 | ❌ 受阻（沙箱 safe-delete 守卫阻断 `--coverage` 的临时目录清理，无法实测；聚合分支覆盖 80.46%，余量 19 分支） |
| 21 | 重写 `ARCHITECTURE.md`，让它描述**代码实际的样子**，并把三条不变量写成可执行的架构测试 | ✅ 已完成（本文件 §5 与 `ARCHITECTURE.md` 持续同步为代码现状） |

---

## 4. 结语

你的代码里有一些**真正做对的地方**，值得保留和扩散：

- **`packages/protocol`**：零运行时依赖、零 I/O，是货真价实的纯内核
- **`packages/editor-core`**：纯内存状态机，无 ANSI、无 `console`、无 I/O，是 Passive View 的合格 Model
- **`packages/ai`**：未耦合任何厂商 SDK
- **`system-clipboard.ts:32`**、**`tree.ts` / `branch-what-if.ts` 的 `clock` / `idGenerator`**：依赖注入的样板
- **模块级可变状态、单例、`globalThis` 污染：全仓库零命中**
- **`TODO` / `FIXME` / `HACK` 零命中**

问题不在于你不懂这些原则——`ARCHITECTURE.md` 证明你完全清楚。问题在于**架构文档是一份 aspirational design，而不是代码现状的描述**，且没有任何机制（架构测试、依赖检查）去强制两者保持一致。`knip.json` 里那句 `"ignoreDependencies": ["@inkpi/*"]` 是个信号：它主动关掉了能发现这类漂移的检查。

**最该先做的不是重构，而是补一条能失败的检查。** 加一个架构测试，断言"agent-core 不得 import `@inkpi/tui` / `@inkpi/storage` / `node:net`"，让 CI 先红一次。之后每一次重构都是在绿灯上前进，而不是靠人记着。
