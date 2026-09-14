# InkPi AI Runtime Specification v1

状态：本地 Phase 23 Atomic Gate 已接入；正式 Freeze 需按原始 20 项重新审计

基线日期：2026-09-14

本文件是 Runtime v1 的接口基线与验收记录。本轮在 Runtime 仓库内新增了只使用本地测试、fixture 和 CI 标记的 20 项 Phase 23 原子门禁；它不替代真实 provider、GUI、双实例、人工标注或生产长期运行证据。`inkpi-evidence/phase18/phase18-23-packaged-human-reviewed-final-20260914.json` 仍是既有的 external/replay 记录，旧 `scripts/final-freeze-audit.mjs` 仍报告 16 个外部聚合组；两者都不会被本地门禁当作新的实现证据。Phase 18 的本地 7 个 objective、7 个 mutation、100/300 章 fixture 和 Phase 22 的 13 个可靠性场景由确定性测试覆盖。真实 provider、Gold/pairwise、GUI、双实例和生产 observability 结论仍按其原有 evidence role 解释，不在本地门禁中自动升级。

## 1. 范围和术语

本规范覆盖：

- Desktop 的 canonical content、canonical story model 和 Creative Intelligence Layer；
- Daemon 的通用 AiTask runtime、ContextPipeline、TaskRouter、执行持久化和 JSON-RPC；
- Desktop IndexedDB 与 Daemon SQLite 之间的 DomainChangeSet projection sync；
- Proposal/CAS、Skills、Artifacts、Cache、Capability Routing、Instruction Registry、Observability 和 eval 门禁。

术语：

- Authoritative：可以决定创作域事实的唯一状态源。
- Derived：由 Authoritative 状态计算出来，可以删除并重新构建的读模型、索引、摘要或缓存。
- Proposal：尚未改变 Authoritative 状态的候选变更。
- Task：一次有明确输入、策略、输出契约和效果边界的 Runtime 执行。
- Context：为 Task 动态编译的结构化片段集合，不等同于完整 Prompt。

状态标记：

- 已有：代码和至少一个针对性测试可以定位到该能力。
- 局部：核心类型或本地路径存在，但生产接入、跨进程链路或持久化尚未完整证明。
- 待验证：本规范要求该能力，但当前仓库没有足够的端到端证据。

## 2. 不变量

以下规则是 v1 的硬边界：

1. Runtime 通用层不得导入或依赖小说/创作领域模型。Creative StoryContextCompiler 只能位于 Desktop。
2. Desktop IndexedDB 是创作域的 Authoritative 状态。Daemon SQLite 只保存 Derived projection、检索、摘要、缓存和执行数据。
3. 所有新的创作 AI 调用必须从 AiTask 进入 TaskRouter。UI 和插件不得直接选择供应商、调用模型或维护完整 Prompt。
4. AI 不得直接消费 HTML。编辑器 JSON、HTML 或纯文本必须先投影为 SemanticDocument。
5. AI 不得直接写 Authoritative Domain State。需要变更时只能返回 Proposal，由 Desktop 审阅、CAS 校验后提交。
6. ExecutionStrategy、SchedulingPolicy、OutputFormat、OutputPersistence 和 EffectPolicy 是相互独立的维度。
7. Skills 必须复用 ExtensionHost、DynamicPluginLoader、ExtensionRunner、ToolRegistry 和现有生命周期能力；不得建立第二套插件运行时。
8. 协议、日志和持久化不得把 private reasoning、raw CoT 或完整 <think> 作为标准数据。
9. 所有可缓存的 Context 和指令组装必须使用确定性排序、稳定 id、内容指纹和 revision 感知失效。
10. 插件不得选择具体模型。模型选择必须由 Runtime 的能力过滤和策略排序完成。

## 3. 系统边界

~~~text
Desktop Tauri + React
  ├─ Editor / Plugin UI
  ├─ Canonical Content / Story Domain
  ├─ IndexedDB authoritative stores
  ├─ CreativeIntelligence
  ├─ AiAssistant.runTask
  └─ DomainSyncService
        │ WebSocket/TCP JSON-RPC
        ▼
Daemon @inkpi/server
  ├─ TaskRouter
  ├─ ContextPipeline
  ├─ TaskModelHandler
  ├─ Task checkpoint/execution stores
  ├─ ToolRegistry / ExtensionHost
  ├─ InstructionRegistry
  └─ SQLite derived stores
        │
        ▼
Model provider abstraction
~~~

当前 Daemon 默认 TCP 端口是 8848，WebSocket 默认使用 TCP 端口加一。实际 Desktop 连接由 inkpiDaemonGateway 和 daemonAiAssistant 适配。

## 4. Canonical Content

实现位置：inkpi-desktop/src/domain/content/

### 4.1 SemanticDocument

~~~ts
interface SemanticDocument {
  documentId: string
  revision: number
  text: string
  blocks: SemanticBlock[]
  sourceMap: TextSourceMap
  representation: 'prosemirror-json' | 'html' | 'text'
}

interface SemanticBlock {
  id: string
  type: string
  text: string
  from: number
  to: number
  editorPosition?: EditorPosition
  metadata?: Record<string, unknown>
}
~~~

当前投影函数：

- semanticDocumentFromProseMirror；
- semanticDocumentFromHtml；
- semanticDocumentFromText；
- projectEditorContent；
- projectContent；
- semanticTextFromContent。

编辑器结构和 HTML 只在投影边界存在。Task 的 input.text、selection 和 context provider 输入应使用 canonical text 或结构化 SemanticDocument 数据。

### 4.2 SourceMap

~~~ts
interface TextSourceMap {
  semanticToEditor(position: number): EditorPosition
  editorToSemantic(position: EditorPosition): number
  semanticRangeToEditor(from: number, to: number): EditorPosition
  editorRangeToSemantic(position: EditorPosition): EditorPosition
  readonly segments: readonly SourceMapSegment[]
}
~~~

当前实现保留 block 与 inline source segment、block id 以及 semantic/editor 起止位置，并处理非有限位置、边界夹取、空 block、间隙和相邻 segment。Desktop 仓库的 `src/domain/content/semanticProjection.test.ts` 覆盖 ProseMirror、HTML inline 文本、换行、注释和 range 映射；Runtime 仓库的 `tests/task-evals.test.ts` 覆盖确定性的 source-map/range 失败。所有编辑器事务和全部复杂嵌套节点变体仍未穷尽验证。

## 5. Canonical Story Model

实现位置：inkpi-desktop/src/domain/story/

~~~ts
interface StoryState {
  revision: number
  entities: Record<string, StoryEntity>
  relations: Record<string, StoryRelation>
  events: Record<string, StoryEvent>
  scenes: Record<string, StoryScene>
  timelines: Record<string, StoryTimeline>
  promises: Record<string, NarrativePromise>
  constraints: Record<string, StoryConstraint>
}
~~~

StoryState 当前提供 createStoryState、各集合的 upsert/remove、withStoryRevision 和 assertStoryState。assertStoryState 要求集合 key 与实体 id 一致，并要求每个条目存在 provenance。

### 5.1 Provenance

实际 StoryFactLevel：

~~~text
canonical-fact
character-belief
rumor
hypothesis
ai-inference
proposal
~~~

实际 Provenance 包含 sourceType、factLevel、sourceDocumentId、sourceBlockId、sourceRevision、confidence、evidence、createdAt 和 createdBy。confidence 若存在必须在 0 到 1 之间。只有 canonical-fact 是 Authoritative 作者事实。

### 5.2 Story Context

storyContextCompiler.ts 把实体、关系、事件、场景、时间线、承诺和约束分组为 StoryContext，并拆出 canonicalFacts 与 hypotheses。createStoryContextProvider 只有在 Task.contextPolicy.includeProjectState 为 true 时提供 story-state fragment。

StoryState 仍由 Desktop 作为创作域 Authoritative 状态；StoryContextCompiler 和 story context provider 已有本地实现。StoryState 持久化、所有插件数据源的规范化提取、Daemon 侧完整注册以及跨进程生产链路仍没有端到端证据。

## 6. AiTask Contract

协议实现位置：inkpi/packages/protocol/src/task.ts。

### 6.1 输入

~~~ts
interface TaskSelection {
  documentId: string
  from: number
  to: number
  blockIds?: string[]
  revision?: number
}

interface TaskInput {
  text?: string
  documentId?: string
  selection?: TaskSelection
  payload?: unknown
}
~~~

### 6.2 ContextPolicy

~~~ts
interface ContextPolicy {
  providerIds?: string[]
  maxTokens?: number
  maxFragments?: number
  includeSelection?: boolean
  includeProjectState?: boolean
  metadata?: Record<string, unknown>
}
~~~

### 6.3 Execution、Output 和 Effect

~~~ts
type ExecutionStrategy = 'completion' | 'reasoning' | 'workflow' | 'agent'
type ExecutionMode = 'interactive' | 'foreground' | 'background' | 'batch'
type SchedulingPolicy = ExecutionMode
type TaskPriority = 'low' | 'normal' | 'high'

interface CheckpointPolicy {
  enabled?: boolean
  intervalMs?: number
  step?: string
}

interface ExecutionPolicy {
  strategy?: ExecutionStrategy
  mode?: ExecutionMode
  scheduling?: ExecutionMode
  priority?: number | TaskPriority
  timeoutMs?: number
  maxAttempts?: number
  cancellable?: boolean
  checkpointIntervalMs?: number
  checkpoint?: CheckpointPolicy
}

type OutputFormat = 'text' | 'structured' | 'patch'
type OutputPersistence = 'ephemeral' | 'session' | 'artifact'

interface OutputContract {
  format: OutputFormat
  schemaId?: string
  persistence?: OutputPersistence
  allowEmpty?: boolean
}

type EffectMode = 'read-only' | 'proposal'

interface EffectPolicy {
  mode: EffectMode
  requiresApproval?: boolean
  allowedScopes?: string[]
}
~~~

### 6.4 完整 AiTask

~~~ts
interface AiTask {
  id: string
  kind: string
  input: TaskInput
  contextPolicy?: ContextPolicy
  executionPolicy?: ExecutionPolicy
  outputContract?: OutputContract
  effectPolicy?: EffectPolicy
  requirements?: TaskRequirements
  intent?: string
  checkpointPolicy?: CheckpointPolicy
  metadata?: Record<string, unknown>
}
~~~

TaskRequirements 当前支持 capabilities、tools、modalities、network、outputFormats、streaming、minContextTokens、maxLatencyMs、maxCostUsd、needsTools、needsStructuredOutput、needsReasoning、needsStreaming 和 minimumContext。

### 6.5 输出和状态

~~~ts
type TaskOutput =
  | { format: 'text'; text: string }
  | { format: 'structured'; data: unknown }
  | { format: 'patch'; patch: unknown }

type TaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'checkpointed'
  | 'waiting-user'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'

type TaskTerminalStatus = 'waiting-user' | 'completed' | 'failed' | 'cancelled'
~~~

interrupted 只出现在 TaskStatusSnapshot 和执行记录中。当前 TaskResult 使用 TaskTerminalStatus，不把 interrupted 作为结果终态。

~~~ts
interface TaskResult {
  taskId: string
  kind: string
  status: TaskTerminalStatus
  output?: TaskOutput
  error?: TaskError
  artifactIds?: string[]
  proposalIds?: string[]
  provenance?: Record<string, unknown>
}
~~~

TaskRouter 在 outputContract 存在时检查输出格式；模型返回错误或非法 structured/patch JSON 时任务失败。

## 7. Desktop AI Port and RPC

### 7.1 Desktop port

实现位置：inkpi-desktop/src/ports/aiGateway.ts。

~~~ts
interface AiGateway {
  connect(url: string): Promise<RpcClient>
}

interface AiAssistant {
  runTask(
    task: AiTask,
    options?: {
      signal?: AbortSignal
      pollIntervalMs?: number
      onProgress?: (snapshot: TaskStatusSnapshot) => void
    },
  ): Promise<TaskResult | null>
  steerTask?(taskId: string, input: unknown): Promise<boolean>
  resumeTask?(taskId: string): Promise<void>
  status(): Promise<{ running: boolean }>
  close(): Promise<void>
}
~~~

daemonAiAssistant.ts 把一次 runTask 实现为 submit、status 轮询和可选 cancel。CreativeIntelligence 使用相同任务协议的 submitTask、getTaskStatus、cancelTask、steerTask 和 resumeTask gateway。

### 7.2 当前公开 Task RPC

| RPC | 参数/返回 | 当前实现 |
| --- | --- | --- |
| task.submit | TaskSubmitParams → TaskSubmitResult | 已有 |
| task.status | TaskStatusParams → TaskStatusSnapshot | 已有 |
| task.cancel | TaskCancelParams → TaskCancelResult | 已有 |
| task.steer | TaskSteerParams → TaskSteerResult | 已有 |
| task.resume | TaskResumeParams → TaskSubmitResult | 已有 |
| task.replay | TaskReplayParams → TaskSubmitResult | 已有 |
| task.fork | TaskForkParams → TaskSubmitResult | 已有 |
| task.event | Daemon notification | 已有，广播 TaskRouterEvent |
| task.execution | 执行记录查询 | 已有，返回 TaskRouter durable execution snapshot |

session.*和 agent.* RPC 仍由 Daemon 提供给旧会话基础设施。它们不属于 v1 Creative Task API，新的创作请求不得依赖这些入口。

## 8. Context Pipeline

实现位置：inkpi/packages/agent-core/src/context/。

### 8.1 接口

~~~ts
interface ContextRequest {
  task: AiTask
  signal?: AbortSignal
  purpose?: string
  projectRevision?: number
  metadata?: Record<string, unknown>
}

interface ContextFragment {
  id: string
  source: string
  kind?: string
  text?: string
  data?: unknown
  content?: unknown
  priority?: number
  relevance?: number
  recency?: number
  dependency?: number
  tokenEstimate?: number
  estimatedTokens?: number
  metadata?: Record<string, unknown>
}

interface ContextPacket {
  fragments: ContextFragment[]
  text: string
  tokenEstimate: number
  fingerprint: string
  truncated: boolean
  projectRevision?: number
  metadata?: Record<string, unknown>
}

interface ContextProvider {
  id: string
  supports?(request: ContextRequest): boolean | Promise<boolean>
  provide(
    request: ContextRequest,
    signal?: AbortSignal,
  ): ContextFragment[] | Promise<ContextFragment[]>
}
~~~

### 8.2 组装规则

ContextPipeline.build 的当前行为：

1. 把 Task.input.text 作为最高 priority 的 task-input fragment。
2. 只访问 Task.contextPolicy.providerIds 指定的 provider；未指定时遍历已注册 provider。
3. 先调用 supports，再调用 provide，并传递 AbortSignal。
4. 按 priority、relevance、dependency、recency 计算分数；同分按 fragment id 排序。
5. 按 id 去重。
6. 按 maxTokens 截断。默认上限为 16,000，token estimate 默认按约 4 个字符计算。
7. 用稳定序列化计算 fingerprint；fingerprint 包含 fragment content、评分字段、token estimate 和 projectRevision。

当前 Daemon 在提供 JitMemoryRetriever 时注册 retrieval.jit 对应的 JitContextProvider。Desktop 任务工厂引用 creative.document、creative.story 和 retrieval.jit，但 document provider 与 Desktop story provider 在跨进程生产配置中的注册仍待核对。

## 9. TaskRouter and Model Handler

### 9.1 TaskRouter

实现位置：inkpi/packages/agent-core/src/tasks/task-router.ts。

TaskRouter 当前负责：

- TaskRegistry 精确 kind、canHandle 和 wildcard handler 解析；
- queued/running/checkpointed/waiting-user/completed/failed/cancelled/interrupted 状态；
- timeout、retry、cancel、resume、steer、replay 和 fork；
- ContextPipeline 构建；
- checkpointStore、executionStore 和任务事件；
- 对结果执行 OutputContract 校验；
- 把 executionRunId、attempt、instruction version/ids 放入 provenance。

TaskRouter.stop 会把非终态任务标记为 interrupted，保留执行记录以便 resume。用户调用 cancel 得到 cancelled；两者必须保持可区分。

### 9.2 Handler contract

~~~ts
interface TaskHandlerContext {
  task: AiTask
  context: ContextPacket
  instructions?: ComposedInstructions
  signal: AbortSignal
  executionRunId: string
  attempt: number
  toolRegistry?: ToolRegistry
  executeTool?(call: ToolCallContent): Promise<ToolResultMessage & { terminate?: boolean }>
  consumeSteering(): unknown[]
  checkpoint?: TaskCheckpoint
  saveCheckpoint(step: string, data: unknown): Promise<void>
  reportProgress(progress: number): void
}
~~~

TaskHandler 只返回 TaskHandlerResult，不具备直接提交 Domain State 的能力。

### 9.3 TaskModelHandler

packages/server/src/task-model-handler.ts 是当前通用模型 handler。它使用注入的 ModelConfig 和 streamAi：

- 根据 task、稳定 instructions、ContextPacket、payload 和 checkpoint 组装模型输入；
- 通过共享 ToolRegistry 执行顺序工具循环；
- 每轮工具调用前消费公开 steering；
- 记录工具 trace 和公开 progress；
- 从返回文本移除 <think> 和私有推理；
- 按 outputContract 解析 text、structured 或 patch。

Daemon 在安装 model handler 时构造 CapabilityRouter；`task.submit` 在入队前解析能力，TaskModelHandler 在执行时使用选定 route，并把 route/provider/model 写入 provenance。单模型旧构造器在未提供能力表时使用兼容能力声明；显式能力表仍按严格匹配处理。Packaged sidecar 已通过 capability selection、provenance 和 mismatch-before-queue；真实 provider 100/300 章结果另有外部证据记录。

## 10. 五个 Vertical Slices

切片的稳定入口必须是 Desktop 任务工厂和 CreativeIntelligence，不能直接从 UI 调模型。

| Slice | Task kind | 当前策略 | 当前状态和缺口 |
| --- | --- | --- | --- |
| VS1 Continue Prose | creative.continue | completion、interactive、text/ephemeral、read-only | Desktop 与当前 NSIS sidecar 均已验证 canonical task 和文本完成结果；真实 Provider、GhostText 安装后 UI 和生产链路仍待验收 |
| VS2 Selection Rewrite | creative.rewrite | completion、interactive、patch/artifact、proposal/approval | Desktop 与当前 NSIS sidecar 均已验证 semantic selection、patch contract、ProposalLedger/CAS 和 patch artifact 读回；真实 Provider、冲突 UI 和生产写回仍待验收 |
| VS3 Continuity Audit | narrative.continuity.audit | workflow、background、structured/artifact、read-only | Desktop 与当前 NSIS sidecar 均已验证 debounce/cancel/dedup、structured result 和 gutter 边界；章节保存生产触发和真实 Provider 链路仍待验收 |
| VS4 Deep Story Reasoning | narrative.deep.reason | reasoning、interactive、structured/artifact、read-only | Desktop 与当前 NSIS sidecar 均已验证工具循环、steering、progress 和 structured result；安装后人机介入、真实 Provider 路由和生产数据仍待验收 |
| VS5 Project Distillation | narrative.project.distill | workflow、background、structured/artifact、read-only | Desktop 与当前 NSIS sidecar 均已验证 chunk、合并、checkpoint/progress、artifact 和结构化结果；大项目真实 benchmark、生产 lineage 和真实 Provider 仍待验收 |

当前 Desktop 任务工厂位于 `inkpi-desktop/src/ai/tasks/taskFactories.ts`，编排位于 Desktop 的 `creativeIntelligence.ts` 和 `verticalSlices.ts`。

## 11. Domain Projection Sync

协议实现位置：inkpi/packages/protocol/src/domain-sync.ts。

### 11.1 DomainChangeSet

~~~ts
interface DomainChange {
  id: string
  aggregateType: string
  aggregateId: string
  operation: 'upsert' | 'delete'
  revision: number
  payload?: unknown
  occurredAt: number
}

interface DomainChangeSet {
  id: string
  workspaceId: string
  sourceDeviceId: string
  baseRevision: number
  revision: number
  changes: DomainChange[]
  checksum: string
  createdAt: number
}
~~~

协议使用 workspaceId；Desktop 当前把 projectId 作为 workspaceId。createDomainChangeSet 生成 revision = baseRevision + 1，并对不含 checksum 的对象做确定性序列化和 32 位 FNV-1a 风格校验。

### 11.2 追加和应用

Desktop：

- IndexedDbProjectRepository 在 project、volume、chapter 的变更写入前追加 change set；
- IndexedDbDomainChangeStore 用队列串行化追加；
- 要求 baseRevision 等于本地最新 revision，revision 等于 baseRevision + 1；
- 相同 id 和相同 checksum 幂等返回；
- 相同 id 的不同 checksum 报 id collision；
- list、snapshot、restore 检查连续 revision、workspaceId 和 checksum。

Daemon：

- DomainProjectionStore.apply/list/createSnapshot/restoreSnapshot 运行同样的校验；
- SQLite 保存 domain_change_sets 和 domain_projection_cursors；
- domain.sync.push、domain.sync.pull、domain.sync.snapshot、domain.sync.restore 由 Daemon 注册；
- cursor 决定当前 Derived projection 已接收的 revision。

### 11.3 重要限制

DomainProjectionStore 现在会在 revision、checksum 和幂等校验通过后调用 DomainMaterializer，把 workspace/project、folder/volume、document/chapter 和 document snapshot change reducer 到 SQLite derived read models；同时按外键依赖处理删除，未知 aggregate 只保留历史不创建读模型。`domain-materializer.test.ts` 覆盖字段别名、删除顺序、重复 change set、snapshot restore/rebuild 和未知 aggregate。

StoryState 的完整物化、冲突解决、多设备合并、乱序输入策略和完整离线重连仍没有跨设备或端到端证据，是 v1 Final 前的剩余门禁。

## 12. Proposal / CAS

### 12.1 DomainProposal

实现位置：inkpi-desktop/src/ai/proposals/domainProposal.ts。

~~~ts
interface DomainProposal {
  id: string
  taskId: string
  baseRevision: number
  sourceHash?: string
  target: { type: string; id: string }
  operation: 'create' | 'update' | 'delete'
  patch?: unknown
  evidence?: DomainProposalEvidence[]
  reason?: string
}
~~~

### 12.2 Desktop 文本 Proposal Ledger

实现位置：inkpi-desktop/src/ai/proposals/proposalLedger.ts。

AiProposal 使用 documentId、baseRevision、TextPatch[]、status、sourceHash、inversePatches 和 committedRevision。状态为：

~~~text
pending → accepted → committed → undone
pending → rejected
accepted/pending/stale → stale
~~~

规则：

1. effectPolicy.mode === 'proposal' 的任务必须声明 requiresApproval === true。
2. ProposalLedger.accept 是 commit 的前置条件。
3. commit 要求 currentRevision === baseRevision；不一致时标记 stale 并抛 ProposalConflictError。
4. 若两侧都有 sourceHash，currentSourceHash 必须相等。
5. rebase 由调用者提供 patch transform，成功后 baseRevision 更新为当前 revision，状态回到 pending。
6. apply 回调负责写入 Desktop Authoritative 状态；Ledger 本身不写 IndexedDB。
7. commit 成功后保存 committedRevision 和 inversePatches。
8. undo 要求 currentRevision === committedRevision，并以新 revision 应用 inversePatches。

当前 DomainProposal 与 AiProposal 仍保留 Desktop 文本提案与 Runtime projection 两个表示，但已有 `proposal.sync.push` / `proposal.sync.snapshot` Daemon RPC 和 Desktop `RemoteProposalStore` 适配。Selection Toolbar、Diff Reviewer 已接入本地提案审阅与 CAS/undo；跨设备一致性、权威提交和生产冲突演练仍待验收。

## 13. Durable Execution

### 13.1 记录

实现位置：

- agent-core/src/tasks/checkpoints.ts；
- agent-core/src/tasks/execution-store.ts；
- server/src/task-checkpoint-store.ts；
- server/src/task-execution-store.ts；
- storage/src/ddl.ts。

当前类型：

~~~ts
interface ExecutionRun {
  id: string
  taskId: string
  status: TaskStatus
  startedAt?: number
  finishedAt?: number
  attempts: number
  updatedAt: number
  resumeToken?: ResumeToken
}

interface ExecutionStep {
  id: string
  runId: string
  step: string
  status: TaskStatus
  startedAt?: number
  finishedAt?: number
  error?: TaskError
}

interface ExecutionAttempt {
  runId: string
  attempt: number
  startedAt: number
  finishedAt?: number
  status: TaskStatus
  error?: TaskError
}

interface ResumeToken {
  taskId: string
  checkpointStep: string
  contextFingerprint?: string
  issuedAt: number
}
~~~

TaskCheckpointStore 当前是每个 task 保留一个最新 checkpoint，字段是 taskId、kind、step、data、contextFingerprint 和 updatedAt。SqliteTaskExecutionStore 保存 TaskExecutionRecord、run、steps、executionAttempts、resumeToken 和 steering。

### 13.2 Retry、Resume、Replay、Fork

- Retry：同一 task 和 execution run 继续尝试，增加 attempt。
- Resume：从 waiting-user、failed、cancelled 或 interrupted 的执行记录/最新 checkpoint 重新排队。
- Replay：复制 task，生成新 task id，并记录 replayOf。
- Fork：复制 task，可带 Partial<AiTask> patch，并记录 forkOf。

TaskScheduler 提供内存队列、优先级、并发上限、dedupe、debounce、timeout、retry、progress，以及可选的 `TaskSchedulerPersistence` 边界和单 task `rehydrate`。它不会自行枚举全部 durable task；生产 durable 语义仍以 TaskRouter + TaskCheckpointStore + TaskExecutionStore 为准。`task-reliability.test.ts` 已覆盖 retry、interrupted hydration、shutdown 后 resume、replay/fork、恢复门禁和重复恢复；SQLite store 另有文件重开、checkpoint/execution JSON 损坏显式失败和 daemon stop/start reload 测试。`tests/process-restart-e2e.test.ts` 已通过真实 Node 子进程写入文件 SQLite、SIGKILL、重启并从 interrupted checkpoint resume，覆盖 OS 进程级 checkpoint recovery；`tests/fault-injection-recovery.test.ts` 另覆盖一次 checkpoint 写失败重试和 partial workflow downstream failure 后从已有 checkpoint 继续；Desktop packaged acceptance 还通过了实际 Windows sidecar 的 checkpoint 强杀、重启 rehydrate 和 resume。GUI/App 安装后人工检查、生产级故障注入、CLI 持久化 handler 链路、自动枚举恢复和生产恢复报告仍缺失。

## 14. Skills、Artifacts、Cache、Capability、Instructions

### 14.1 Skills / Progressive Disclosure

实现位置：inkpi/packages/agent-core/src/skills/progressive-disclosure.ts。

~~~ts
interface SkillManifest {
  id: string
  version: string
  title: string
  description: string
  intents?: string[]
  capabilities?: string[]
  taskKinds?: string[]
  tools?: string[]
  activation: 'eager' | 'lazy' | 'on-demand'
}
~~~

ProgressiveSkillRuntime 的实际步骤是：

~~~text
SkillDiscoveryEngine metadata scan
  → resolve(intent/capability/taskKind)
  → load(skill body)
  → DynamicPluginLoader
  → ExtensionHost
  → existing ToolRegistry
~~~

当前 discovery 使用 Markdown frontmatter 的 metadata，load 才读取 promptBody。第一批四个 manifest 已存在于 `inkpi/skills/hook.md`、`promise.md`、`character-voice.md` 和 `timeline-consistency.md`；`tests/skills-instructions.test.ts` 覆盖 metadata-first discovery、lazy body loading、按 capability/task kind resolve 和 instruction composition；`tests/skill-runtime-integration.test.ts` 覆盖共享 ExtensionHost、ToolRegistry、TaskRegistry、ContextPipeline 的注册、失败回滚、重试和并发幂等；`tests/first-party-skill-activation.test.ts` 已逐个加载真实 manifest 并验证激活回滚/重试/幂等；Desktop packaged acceptance 已从 NSIS 资源中发现并激活四个 Skill，经 RPC 验证 instruction composition。最终冻结组已通过；未在该证据中宣称长期生产规模运行。

### 14.2 Artifacts

实现位置：inkpi-desktop/src/ai/artifacts/artifactStore.ts。

~~~ts
interface Artifact {
  id: string
  type: string
  version: number
  content: unknown
  provenance: {
    taskId?: string
    executionRunId?: string
    sessionId?: string
    parentArtifactId?: string
    [key: string]: unknown
  }
  createdAt: number
  updatedAt: number
}
~~~

当前 IndexedDbArtifactStore 写入 `aiArtifacts`，ArtifactRuntime 只在结果为 completed/waiting-user 且 output persistence 为 artifact 时持久化。Desktop 的 CreativeIntelligence 已接入自动持久化和 cache-hit rehydration；Desktop 本地测试覆盖 semantic content、确定性 id、parent/source/execution lineage、重复保存、同 id 冲突和失败/ephemeral 不落盘。预定义 creative artifact type 包括 story-plan、character-state、open-threads、chapter-summary、audit-report 和 distillation-checkpoint。

Artifact 是 Runtime semantic object；JSON/Markdown 只是导出格式。Daemon 已提供 `artifact.save`、`artifact.get`、`artifact.list` RPC，Desktop `DaemonArtifactStore` 已完成字段映射；本地 TCP/重开测试已覆盖保存、读取、筛选和 lineage。跨设备 artifact sync、ownership、lineage 关联和生产导出验收仍缺，不应宣称全链路完成。

### 14.3 Cache

实现位置：inkpi-desktop/src/ai/cache/contextCache.ts。

当前有三层：context、semantic、provider。ContextCacheKey 可包含 taskKind、contextFingerprint、projectRevision、model/modelId、instructionVersion、skillVersion、providerId 和 layer。实现提供 TTL、LRU 淘汰和 hits/misses/evictions。

Desktop 的 `daemonAiAssistant` 已把 `runTask` 路由到 CreativeIntelligence；ContextCache 已接入 provider-response 路径。cache key 包含 task kind、context/intent fingerprint、project revision、instruction/skill version、route provider/model 和 layer，cache hit 会复用结果并补齐 artifact。Desktop 的 `contextCache.test.ts` 和 `creativeIntelligence.test.ts` 覆盖 TTL、LRU、hit/miss、revision/instruction/skill/model/provider 失效和 cache-hit artifact rehydration。Runtime `ContextPipeline` 另有默认编译缓存，按 task/provider/revision 稳定序列化并深拷贝结果，`context-cache-pipeline-integration.test.ts` 通过真实 JIT/SQLite retrieval 验证命中和 revision 失效。

ContextPipeline/retrieval 与 Desktop provider-response 的共享三层默认调用链、跨重启策略和真实命中率仍待接入或测量，不能把本地 cache 接入写成全链路完成。

### 14.4 Capability Routing

实现位置：inkpi-desktop/src/ai/routing/capabilityRouter.ts。

ModelCapabilities 当前描述 streaming、toolCalling、parallelToolCalling、structuredOutput、jsonSchema、reasoning、promptCaching、imageInput、maxContextTokens 和 maxOutputTokens，并保留 text、patchOutput、tools、vision、offline、quality、latency 和 cost 兼容字段。

CapabilityRouter.select：

1. 过滤网络要求和 route capabilities；
2. 过滤 streaming、reasoning、tools、structured/json schema、vision、context、latency、cost 和 output format；
3. 按 route priority、quality 和 latency bonus 排序；
4. 无满足条件的 route 时抛 NoCapableRouteError。

Desktop CreativeIntelligence 在提交前执行 CapabilityRouter.select；Daemon 的 `task.submit` 在入队前执行 CapabilityRouter.resolve，TaskModelHandler 再按选定 route 执行并记录 route provenance。两个仓库的路由测试覆盖能力过滤、确定性排序、兼容别名、schema/output contract 和 mismatch-before-queue；当前 NSIS sidecar 也已验证兼容任务选路、route provenance 和不匹配任务入队前拒绝。真实 provider capability matrix、跨进程真实模型配置和生产 fallback 行为仍待验证。

### 14.5 Instruction Registry

实现位置：inkpi/packages/agent-core/src/instructions/instruction-registry.ts。

InstructionRegistry 支持 register、registerDefinition、upsert、unregister、list、compose、composeForTask 和 resolve。InstructionEntry 有 id、scope、content、priority、tags、enabled、version 和 source；compose 返回 text、entryIds、truncated 和 registry version。

TaskRouter 在执行时按 task kind 组合 instructions，并把 entry ids 和 version 放到结果 provenance。Daemon 提供 `instruction.register`、`instruction.list` 和 `instruction.status`；注册是可重复的，已有 entry 按版本更新。Desktop 的 `daemonAiAssistant` 在首个 task batch 前共享同一个 registration promise，自动提交 6 个核心和 22 个插件指令定义。两个仓库均有 registry、TaskModelHandler fallback 和 Desktop adapter 的本地测试；metadata instruction 只作为未注册 task 的兼容 fallback。

## 15. Observability / Provenance

每个 Task 的公开观测至少应覆盖：

| 字段 | 当前状态 |
| --- | --- |
| taskId、kind、status、startedAt、finishedAt、progress | TaskRouter observer/event 已有 |
| executionRunId、attempt、checkpoint | TaskRouter 和执行记录已有 |
| instruction ids/version | TaskRouter result provenance 已有 |
| context sources、fingerprint、token count、project revision | TaskModelHandler provenance 已有 |
| provider、model、latency、usage | TaskModelHandler provenance 已有 |
| tool calls/tool errors | TaskModelHandler tool trace 已有 |
| result type、artifact ids、proposal ids | TaskResult/observer 已有 |
| skill ids/version | TaskObservability schema、Desktop result provenance 和测试已支持；自动从 Skill runtime 注入仍未统一 |
| cache hit/miss | Desktop CreativeIntelligence provenance 和 TaskObservability 字段已支持；跨层统计未统一 |
| checkpoint/artifact lineage | TaskRouter execution、ArtifactRuntime lineage 和本地测试已有；跨进程关联待验证 |
| error code/message | 已有摘要；生产脱敏策略待验证 |

TaskRouter 的 sanitizeProvenance 会移除 thinking、reasoning、chainOfThought、cot 和 rawThinking。TaskModelHandler 也会移除完整 <think>。禁止把完整 Prompt、私有 CoT 或模型隐藏推理写入默认日志和持久化记录。

## 16. 插件边界和迁移

Desktop 的 first-party catalog 位于 inkpi-desktop/src/ai/tasks/pluginCatalog.ts，共 44 个 id，并由 architecture-ai.test.ts 与 src/core/pluginRegistry 对齐检查。

当前 Desktop 有 22 个插件组件通过 `PluginHostContext.aiAssistant.runPluginTask` 创建 `plugin.<id>.analysis` 任务；4 个 Tool 插件通过 `runPluginTool` 调用 Daemon 的受控 `tool.execute`，2 个 Workflow 插件通过 `runPluginWorkflow` 进入 Runtime TaskRouter。其余插件已在 Desktop 的 `src/ai/tasks/pluginRuntimeCatalog.ts` 明确映射为 A–G 边界；Desktop 的迁移测试保证 44 个 first-party id 恰好覆盖一次。

~~~text
A Pure Local Algorithm
B AI Task
C Context Provider
D Tool
E Workflow
F UI-only
G Hybrid
~~~

已建立的边界：

- 插件 UI 不直接导入 @inkpi/ai 或其他模型 SDK；
- 插件 UI 不直接构造完整 Prompt；
- 插件 UI 不直接调用模型；
- 插件 AI 分析通过 createPluginAnalysisTask 和 runPluginTask；Tool/Workflow 通过 Runtime-owned adapter；
- AI 结果不绕过 Desktop review/CAS 直接改变创作域。

44 个插件的本地分类、Runtime target 和架构边界已有代码与测试证据；4 个 Tool、2 个 Workflow 已有 Runtime 注册、Daemon RPC 白名单和 Desktop adapter 测试。Tauri NSIS 安装包已经完成构建，release smoke 已确认 Desktop 启动、sidecar 监听 8848/8849 和关闭后重启，但跨设备生产插件运行和旧兼容基础设施的完整审计仍未完成，因此 Phase 20–21 仍只能声明为本地完成、端到端待验证。

## 17. Evals 和发布门禁

当前 evals 位置：inkpi/packages/evals/。

已有 fixture 分组：

~~~text
semantic-content
retrieval
continuity
character-voice
timeline
foreshadowing
hook
distillation
long-context
mutation
~~~

已有 runner 可以检查 task status、output contract、required provenance 和 proposal approval；已有 long-context fixture、mutation helper，以及 `packages/evals/fixtures/subjective/` 下的 canonical gold-set、pairwise preference 和 rubric fixture。当前 deterministic 与 subjective 测试已覆盖实体/状态矛盾、source-map/range、100/300 chapter budget、mutation、distillation checkpoint、候选评分、pairwise 排名和 rubric 门禁，并验证 fixture JSON 与 CI workflow 清单。long-context benchmark 现已提供 retrieval recall、cache hit/invalidation 和 distillation recovery 的可注入指标与阈值门禁；默认报告仍明确为 `fixture-only`，不产生真实 provider 或生产数据证据。

`.github/workflows/evals.yml` 已把 `pnpm run test:evals` 接入 push、pull request 和手动触发的 CI。`acceptance:real-provider` 已提供显式环境门控、凭据检查和 marker 报告，但默认不调用外部 provider。当前 deterministic suite、canonical subjective fixture suite、真实 provider 100/300 章 evidence、人工 Gold/pairwise、可靠性矩阵和 packaged sidecar 门禁均有可复现或带来源的证据。正式汇总见 `inkpi-evidence/phase18/phase18-23-packaged-human-reviewed-final-20260914.json`。
`.github/workflows/evals.yml` 除 `pnpm run test:evals` 外，还直接运行 `tests/phase23-local-freeze.test.ts`、Phase 22 reliability matrix 和 20 项门禁引用的本地回归文件。`packages/evals/src/phase23-local-gate.ts` 是本地门禁的唯一矩阵实现，`packages/evals/fixtures/phase23/local-gate-contract.json` 是 fixture-only 契约：provider/model 调用数为 0，7/7 objective、7/7 mutation 和 100/300 章 benchmark 只用于确定性回归。external/replay 记录只计入 `ignoredCount`，`usedForEligibility` 固定为 `false`。`acceptance:real-provider` 仍提供显式环境门控，但默认不调用外部 provider；正式外部汇总仍见 `inkpi-evidence/phase18/phase18-23-packaged-human-reviewed-final-20260914.json`。

- 真实 provider 的 100/300 章 marker、retrieval、recovery 结果；
- 7 类 objective assertion、7 类 mutation triplet 和 6 个 Gold/3 个 pairwise 主观验收；
- 真实 context pruning、retrieval recall、cache hit rate、checkpoint/recovery 的证据汇总；
- 五个 Vertical Slice 的 Desktop ↔ Daemon packaged acceptance；
- GUI、双实例、observability、插件迁移和可靠性证据组。

单元测试通过不等于 v1 Final。每次契约变更还必须通过 typecheck、lint、unit、architecture、RPC/integration 和相关 regression eval。

## 18. 当前一致性矩阵

| Phase / 能力 | 代码证据 | v1 状态 |
| --- | --- | --- |
| Phase 0 架构不变量 | RFC、Runtime architecture tests、Desktop architecture-ai/content-boundary tests、architecture-gates.yml | 本地边界和 CI 接线完成；兼容 RPC/接口文档与生产边界审计仍缺 |
| Phase 1 canonical content | SemanticDocument、SourceMap、sourceMap.boundaries.test；WriterDesk/RichEditor 中央插件入口、CheckTools 规则扫描、Memory Palace 搜索、Expectation Engine 输入和 ShadowReader 本地推演均有 semantic projection 回归；新增 AST/taint content-boundary gate、22 个 task 与 6 个 Runtime tool/workflow 输入审计、嵌套 ProseMirror 叶节点精确映射 | 本地输入边界和审计完成；复杂编辑器事务映射、生产数据链路和安装后全输入证据仍缺 |
| Phase 2 story model | StoryState、Provenance、IndexedDbStoryStateStore、pluginProjection、确定性 StoryState JSON wire boundary、Runtime TCP/restart domain projection | 本地模型、IndexedDB 权威持久化、JSON 结构校验和跨进程回归完成；完整生产跨设备路径仍缺 |
| Phase 3–5 task contract/router | protocol task.ts、TaskRegistry、TaskRouter、task-rpc tests | 本地 contract/router 和公开 execution/query RPC 完成；跨边界验收仍缺 |
| Phase 6 context pipeline | ContextPipeline、JitContextProvider、context-cache-pipeline-integration、serialized-creative-context-provider、serialized CreativeContext schema gate | 本地流水线/JIT 检索、Desktop→Daemon 序列化 provider 接线和字段校验完成；生产预算/统计仍缺 |
| Phase 7 creative layer | taskFactories、StoryContextCompiler、CreativeIntelligence | 本地编排边界完成；完整真实 provider/context 链路仍缺 |
| Phase 8 five slices | verticalSlices、desktopDaemonIntegration、desktopDaemonVerticalSlices、desktopFiveSliceGate、editor-ai-chain、RichEditor/extension tests、Tauri release smoke | 五条切片的 Desktop↔Daemon WebSocket fixture harness、GhostText、gutter marker、长任务 UI 测试和安装包 sidecar 启动 smoke 完成；真实 Provider、打包 UI 任务恢复和生产数据重启演练仍缺 |
| Phase 9 projection sync | DomainChangeSet、DomainMaterializer、IndexedDbDomainChangeStore、domainSync tests | 本地 reducer/恢复完成；跨设备/跨进程一致性证据仍缺 |
| Phase 10 Proposal/CAS | DomainProposal、DomainProposalLedger、Selection Toolbar、Diff Reviewer durable proposal writeback、CAS/undo tests | 本地 Proposal/CAS/Undo 完成，Diff Reviewer 写回也进入 IndexedDB Proposal Ledger；完整跨边界 proposal 流程仍缺 |
| Phase 11 durable execution | SqliteTaskExecutionStore、SqliteTaskCheckpointStore、process-restart-e2e、fault-injection、Desktop↔daemon task recovery、Tauri release restart smoke | OS 进程恢复、故障注入、Desktop↔daemon 子进程恢复/resume、Desktop App recovery bootstrap 测试和启动/重启 smoke 完成；打包 App 内任务恢复与生产级故障报告仍缺 |
| Phase 12 skills | ProgressiveSkillRuntime、4 个 first-party manifest、skill-runtime-cross-process、Desktop skill adapter、Tauri resources | Runtime/child-daemon 跨进程逐个激活测试和安装包资源已完成；打包 App 实际 UI 激活与生产运行仍缺 |
| Phase 13 artifacts | ArtifactRuntime、SqliteArtifactStore、IndexedDbArtifactStore、artifact-rpc-e2e | 本地 store/RPC/lineage 完成；完整 daemon 同步和 ownership 边界仍缺 |
| Phase 14 cache | 6 段 Prompt 固定装配、ContextPacket 指纹、三层 Cache（Context/Semantic/Provider）、跨重启恢复 | 本地缓存与持久化完成；当前 NSIS sidecar 已实际观察 Context/Retrieval/Provider hit 与手动失效；生产共享统计与长期数据仍缺 |
| Phase 15 capability routing | ModelCapabilities、CapabilityRouter、mismatch-before-queue、failover tests | 声明/选择/failover 完成；真实 provider matrix/config 仍缺 |
| Phase 16 instructions | InstructionRegistry、coreInstructions、pluginInstructions、daemonInstructionHandshake | 本地 registry/handshake 和 packaged sidecar `instruction.status` 完成；安装后 UI 激活与生产跨进程注册链仍缺 |
| Phase 17 scheduler | TaskScheduler、TaskSchedulerPersistence.list、rehydrate/rehydrateAll、SqliteTaskSchedulerPersistence、lifecycle events | 本地队列/持久化/批量恢复完成；生产 durable lifecycle 与重启报告仍缺 |
| Phase 18 evals | fixtures、EvalRunner、7 类 objective assertion、7 类 mutation triplet、100/300 章长上下文基准、retrieval/cache/recovery 指标门禁、`phase23-local-freeze.test.ts`、evals.yml；真实 evidence envelope、Gold/pairwise 仍单独保留 | 本地 deterministic fixture gate 通过；真实 provider 和 human-labelled 结果仍是 external/replay，不由本地 fixture 产生 |
| Phase 19 observability | TaskObservability、23 个公开 observation 字段、sanitizePrivateData、observation sink、`INKPI_OBSERVABILITY_SAMPLE_RATE` 配置、task-observability/task-provenance tests | 本地字段完整性、采样、脱敏和嵌套 private reasoning 过滤门禁覆盖；生产采样规模、访问控制、跨进程 redaction 与跨层审计仍未声明完成 |
| Phase 20–21 plugins/legacy | 44 插件全量 A–G 归类、22 路由插件、4 个 Runtime Tool、2 个 Runtime Workflow、Daemon 白名单 RPC、pluginRuntimeMigration tests、WriterDesk/RichEditor 中央语义输入边界、AST/taint content-boundary gate、Tauri release smoke | 本地分类、child-daemon 激活、RPC、中央入口语义投影、NSIS 构建、sidecar 启动 smoke、通用 workflow API 和 legacy AI gateway 清理完成；当前 packaged sidecar opt-in 已实际执行 4 个 Tool 与 2 个 Workflow；打包 App 生产插件运行和完整生产 interface 审计仍缺 |
| Phase 22 reliability review | 13 个场景的 `PHASE22_RELIABILITY_SCENARIOS`、phase22-reliability-matrix、fault injection、RPC/restart/cache/provider tests | 本地 13/13 场景进入 deterministic gate；生产故障、真实 provider 和长期运行仍未声明完成 |
| Phase 23 final freeze | `PHASE23_ATOMIC_CONDITIONS` 的 20 个原子条件、source marker、CI 直接执行和 Final Freeze audit 规则 | 本地门禁以 20 项为准；旧 `final-freeze-audit.mjs` 的 16 组 external/replay 汇总不是 20 项实现证据的替代物 |

## 19. Final Freeze Checklist

以下清单是本地 Final Freeze Gate 的映射说明。当前本地 gate 只接受 Runtime 仓库内的 test、fixture、workflow 来源；它不把 fixture、旧 external/replay JSON、GUI 记录或真实 provider 结果转换成新的实现证据。

原 plan 在 Phase 23 定义 20 个原子条件。本地实现逐项保留这 20 个 ID，并额外要求 Phase 22 的 13 个可靠性场景；旧 16 组审计仍作为历史 external/replay 聚合入口保留，但不能满足本地 20 项资格。

运行本地闭环：

~~~text
pnpm exec vitest run tests/phase23-local-freeze.test.ts
pnpm --filter @inkpi/evals run build
~~~

测试输出是本地回归结果，不是 Phase 18/23 外部 evidence JSON。实现不修改 agent-core、Desktop 源码或既有 Phase 18/23 外部证据。

`pnpm run audit:final-freeze`（实现见 `scripts/final-freeze-audit.mjs`）仍是旧 external evidence 汇总入口。它要求 16 个验收组各自提供带时间戳的来源记录；本轮不修改该脚本，也不把它的输出当作本地 20 项门禁结果。

### 19.1 Phase 23 原始 Plan 的 20 项原子映射

`packages/evals/src/phase23-local-gate.ts` 中的 `PHASE23_ATOMIC_CONDITIONS` 是可执行矩阵的 source of truth。每个条目必须提供精确的本地 source ref 和 marker；缺失、失败、重复、路径越界或 external/replay 来源都会使 gate 不能通过。

| ID | 原始 Plan 条件 | 本地来源 |
| --- | --- | --- |
| `canonical-content` | Canonical Content Representation 稳定 | `tests/semantic-content-boundaries.test.ts`、`packages/evals/fixtures/semantic-content/source-map-range.json` |
| `canonical-story-model` | Canonical Story Model 稳定 | `tests/domain-sync.test.ts`、`tests/final-freeze-cross-boundary.test.ts` |
| `continue-prose` | Continue Prose 稳定 | `tests/task-evals.test.ts`、`tests/first-party-skill-activation.test.ts` |
| `selection-rewrite` | Selection Rewrite 稳定 | `tests/task-evals.test.ts`、`tests/first-party-skill-activation.test.ts` |
| `continuity-audit` | Continuity Audit 稳定 | `tests/task-contract.test.ts`、`tests/first-party-skill-activation.test.ts` |
| `deep-story-reasoning` | Deep Story Reasoning 稳定 | `tests/first-party-skill-activation.test.ts` |
| `project-distillation` | Project Distillation 稳定 | `tests/first-party-skill-activation.test.ts` |
| `projection-sync` | Projection Sync 稳定 | `tests/domain-sync.test.ts` |
| `proposal-commit` | Proposal → Commit 稳定 | `tests/runtime-phase9-13.test.ts`、`tests/proposal-sync.test.ts` |
| `optimistic-concurrency` | Optimistic Concurrency 稳定 | `tests/proposal-sync.test.ts`、`tests/phase22-reliability-matrix.test.ts` |
| `durable-execution` | Durable Execution 稳定 | `tests/process-restart-e2e.test.ts`、`tests/fault-injection-recovery.test.ts` |
| `context-pipeline` | Context Pipeline 稳定 | `tests/context-cache-pipeline-integration.test.ts`、`tests/context-overflow-reliability.test.ts` |
| `story-context-compiler` | Story Context Compiler 稳定 | `tests/serialized-creative-context-provider.test.ts` |
| `skill-lazy-loading` | Skill Lazy Loading 稳定 | `tests/first-party-skill-activation.test.ts`、`tests/skills-instructions.test.ts` |
| `artifact-store` | Artifact Store 稳定 | `tests/artifact-rpc-e2e.test.ts` |
| `cache-architecture` | Cache Architecture 稳定 | `tests/runtime-cache-cross-layer.test.ts`、`tests/runtime-cache-persistence-restart.test.ts` |
| `capability-aware-model-routing` | Capability-aware Model Routing 稳定 | `tests/phase22-reliability-matrix.test.ts`、`tests/provider-route-fallback.test.ts` |
| `evals-in-ci` | Evals 进入 CI | `.github/workflows/evals.yml`、`tests/phase23-local-freeze.test.ts` |
| `observability` | Observability 完成 | `tests/task-provenance.test.ts`、`tests/task-observability.test.ts` |
| `legacy-ai-paths` | 主要 Legacy AI 路径删除 | `tests/phase20-21-plugin-legacy-architecture.test.ts` |

### 19.2 Phase 22 的 13 个可靠性场景

本地 gate 对以下场景逐项计数，任何缺失或失败都会使报告保持 `pending`：`crash-test`、`daemon-restart`、`offline-desktop`、`broken-network`、`stale-proposal`、`duplicate-task`、`out-of-order-delta`、`corrupt-checkpoint`、`model-unavailable`、`provider-capability-mismatch`、`invalid-structured-output`、`context-overflow`、`cache-invalidation`。来源矩阵同样位于 `phase23-local-gate.ts`，并由 `tests/phase23-local-freeze.test.ts` 和 `tests/phase22-reliability-matrix.test.ts` 执行。

### 19.3 历史外部聚合清单

下方旧清单仅保留为 external/replay 证据索引。其 16 组 `[x]` 标记不代表本地 20 项 Atomic Gate 已通过，也不改变真实 provider、GUI、双实例、人工标注或生产 observability 的 evidence role。

- [x] SemanticDocument、SourceMap 对所有支持的编辑器输入稳定（WriterDesk/RichEditor 中央插件入口、规则扫描、Memory Palace 搜索、Expectation Engine 和 ShadowReader 已补 semantic projection 回归；AST/taint content-boundary gate、22 个 task 与 6 个 Runtime tool/workflow 输入审计已加入；复杂编辑器事务映射、生产数据链路和安装后全输入证据仍缺）；
- [x] StoryState、Provenance 和 canonical fact 读写路径稳定（reducer/store、严格确定性 JSON wire boundary 测试通过；完整生产跨进程路径仍缺）；
- [x] Continue、Rewrite、Continuity Audit、Deep Reasoning、Distillation 五个切片通过 Desktop ↔ Daemon 集成测试（五条切片 WebSocket fixture harness、GhostText、gutter marker、长任务 UI 测试、Tauri NSIS 构建和 packaged sidecar 五切片/恢复通过；真实 Provider、安装后 UI 任务恢复和生产数据重启演练仍缺）；
- [x] DomainChangeSet 的 materialized projection reducer、幂等、乱序、checksum、snapshot 和离线恢复通过测试（本地测试及双持久化 daemon 同步测试通过；真实跨设备/生产一致性证据仍缺）；
- [x] Proposal → Review → CAS Commit → Undo 在 IndexedDB 上通过并发测试（Selection Toolbar 与 Diff Reviewer 写回、双持久化 daemon proposal 同步测试通过；完整生产边界仍缺）；
- [x] Daemon crash、App restart、checkpoint corruption、partial workflow resume 有报告（OS crash/checkpoint/fault injection、Desktop↔daemon 子进程恢复/resume、packaged sidecar recovery 和 App recovery 测试已测；安装后 GUI/App restart、生产级故障报告仍缺）；
- [x] Context provider registration、budget、fingerprint 和 overflow 行为稳定（本地 contract 通过；跨进程注册和生产预算证据仍缺）；
- [x] 第一批四个 creative skill 有逐个激活的真实 manifest、lazy loading、ExtensionHost/ToolRegistry 注册测试（child-daemon 跨进程测试、Tauri resources、安装包构建和 packaged sidecar RPC 激活通过；安装后 UI 激活与生产运行仍缺）；
- [x] ArtifactStore、lineage 和导出边界稳定（本地 RPC/store/export 测试通过；完整 daemon 同步和 ownership 边界仍缺）；
- [x] 三层 Cache 接入真实调用链并有 hit/miss/invalidation 数据（本地调用链和持久化测试通过；packaged sidecar 已实际观察 Context/Retrieval/Provider hit 与手动失效；生产共享统计与长期数据仍缺）；
- [x] CapabilityRouter 接入强制模型选择，并覆盖 capability mismatch 和 retryable route failover（声明与 failover 测试通过；真实 provider matrix/config 仍缺）；
- [x] InstructionRegistry 统一 Desktop/Daemon 的 id/version/provenance（本地 registry/handshake 与 packaged sidecar `instruction.status` 通过；安装后 UI 激活与生产跨进程注册链仍缺）；
- [x] Evals 进入 CI，包含客观、canonical subjective fixture、mutation 和长上下文回归（deterministic CI、7 类 objective assertion、7 类 mutation triplet、真实 Agnes provider 100/300 章 evidence envelope digest、6 个 project-owner Gold、3 个 project-owner pairwise 和完整 rubric 门禁均已通过）；
- [x] Observability 完成字段、采样、脱敏和无 raw CoT 验证（本地字段、`INKPI_OBSERVABILITY_SAMPLE_RATE` 配置、CoT 别名过滤、JSONL 落盘前脱敏测试和一次真实 Runtime 采样通过；生产采样规模、文件访问控制、跨进程 redaction 和 raw-CoT 审计仍缺）；
- [x] 44 个插件完成分类和迁移，Legacy AI 路径和过期接口文档清理（44 个分类、child-daemon Runtime 注册、Daemon 白名单 RPC、Desktop adapter、中央入口 semantic projection、NSIS 构建和 release sidecar smoke 通过；打包 App 生产插件运行和完整 legacy/interface 审计仍缺）；
- [x] 完成 offline、network failure、stale proposal、duplicate task、model unavailable、invalid structured output、context overflow 和 cache invalidation 演练（Runtime/ Desktop 可靠性矩阵、离线恢复 UI 门控、packaged sidecar/App recovery 测试通过；安装后 GUI、生产故障与真实 model-unavailable 证据仍缺）。
