# InkPi AI Runtime Specification v1

状态：条件冻结草案（Conditional Freeze Draft）

基线日期：2026-09-09

本文件是 Runtime v1 的正式接口基线，但不是最终验收声明。Phase 0–23 中仍有未完成或未验证项，见第 18–19 节。只有所有必需项完成并有测试证据后，才能把状态改为 Final。

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

当前实现使用 block segment 和区间比例映射。block id、semantic/editor 起止位置都被保留。复杂节点、嵌套标记、空 block 和所有编辑器事务的映射正确性仍属于待补充测试项。

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

StoryState 的持久化、所有插件数据源的规范化提取和 Daemon 侧完整注册尚未形成端到端实现。

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
| task.execution | 执行记录查询 | 当前没有公开 RPC |

session.* 和 agent.* RPC 仍由 Daemon 提供给旧会话基础设施。它们不属于 v1 Creative Task API，新的创作请求不得依赖这些入口。

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

当前 Daemon 默认构造的是固定 ModelConfig 的 TaskModelHandler；CapabilityRouter 尚未成为 TaskRouter 的强制选择步骤。

## 10. 五个 Vertical Slices

切片的稳定入口必须是 Desktop 任务工厂和 CreativeIntelligence，不能直接从 UI 调模型。

| Slice | Task kind | 当前策略 | 当前状态和缺口 |
| --- | --- | --- | --- |
| VS1 Continue Prose | creative.continue | completion、interactive、text/ephemeral、read-only | requestGhost 已通过 AiAssistant.runTask；Daemon 与 GhostText 真实链路未验收 |
| VS2 Selection Rewrite | creative.rewrite | completion、interactive、patch/artifact、proposal/approval | ProposalLedger 有审阅和 CAS 逻辑；跨端持久化、冲突 UI 和完整 commit 链路待验收 |
| VS3 Continuity Audit | narrative.continuity.audit | workflow、background、structured/artifact、read-only | ContinuityAuditScheduler 有 debounce/cancel/dedup 和测试；章节保存触发及 gutter marker 未确认 |
| VS4 Deep Story Reasoning | narrative.deep.reason | reasoning、interactive、structured/artifact、read-only | 工具循环、steering 和 progress 路径存在；长任务 UI、人机介入和模型路由待验收 |
| VS5 Project Distillation | narrative.project.distill | workflow、background、structured/artifact、read-only | ProjectDistillationWorkflow 支持 chunk、合并、checkpoint、部分失败；大项目 benchmark、restart resume 和 lineage 待验收 |

当前 Desktop 任务工厂位于 inkpi-desktop/src/ai/tasks/taskFactories.ts，编排位于 creativeIntelligence.ts 和 verticalSlices.ts。

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

当前 DomainProjectionStore 已有日志和游标，但没有被代码证据证明会把每个 change 的 payload reducer 到 documents、StoryState 或其他具体读模型。该 reducer、冲突解决、多设备合并和完整离线重连是 v1 Final 前的必需项。

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

当前 DomainProposal 与 AiProposal 尚未合并为一个统一持久化协议，也没有 Daemon Proposal RPC。Selection Toolbar 已接入本地文本提案审阅；跨设备和跨窗口提交待验收。

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

TaskScheduler 另提供内存中的队列、优先级、并发上限、dedupe、debounce、timeout、retry 和 progress；它自身没有 durable checkpoint 或 restart recovery。Durable v1 语义以 TaskRouter + TaskCheckpointStore + TaskExecutionStore 为准。

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

当前 discovery 使用 markdown frontmatter 的 metadata，load 才读取 promptBody。通用 runtime 已有，但四个第一批 creative skill（hook、promise、character-voice、timeline-consistency）的实际 manifest、加载路径和 CI 验收仍待验证。

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

当前 IndexedDbArtifactStore 写入 aiArtifacts，ArtifactRuntime 只在结果为 completed/waiting-user 且 output persistence 为 artifact 时持久化。预定义 creative artifact type 包括 story-plan、character-state、open-threads、chapter-summary、audit-report 和 distillation-checkpoint。

Artifact 是 Runtime semantic object；JSON/Markdown 只是导出格式。当前没有 Daemon Artifact RPC 或 artifact sync。

### 14.3 Cache

实现位置：inkpi-desktop/src/ai/cache/contextCache.ts。

当前有三层：context、semantic、provider。ContextCacheKey 可包含 taskKind、contextFingerprint、projectRevision、model/modelId、instructionVersion、skillVersion、providerId 和 layer。实现提供 TTL、LRU 淘汰和 hits/misses/evictions。

缓存工具尚未证明已挂入 ContextPipeline、retrieval 或 provider 调用默认路径。三层的真实命中率、失效和跨重启策略待测量。

### 14.4 Capability Routing

实现位置：inkpi-desktop/src/ai/routing/capabilityRouter.ts。

ModelCapabilities 当前描述 streaming、toolCalling、parallelToolCalling、structuredOutput、jsonSchema、reasoning、promptCaching、imageInput、maxContextTokens 和 maxOutputTokens，并保留 text、patchOutput、tools、vision、offline、quality、latency 和 cost 兼容字段。

CapabilityRouter.select：

1. 过滤网络要求和 route capabilities；
2. 过滤 streaming、reasoning、tools、structured/json schema、vision、context、latency、cost 和 output format；
3. 按 route priority、quality 和 latency bonus 排序；
4. 无满足条件的 route 时抛 NoCapableRouteError。

当前 Daemon 仍向 TaskModelHandler 注入固定 ModelConfig，CapabilityRouter 没有成为强制 Runtime 选择步骤。

### 14.5 Instruction Registry

实现位置：inkpi/packages/agent-core/src/instructions/instruction-registry.ts。

InstructionRegistry 支持 register、registerDefinition、upsert、unregister、list、compose、composeForTask 和 resolve。InstructionEntry 有 id、scope、content、priority、tags、enabled、version 和 source；compose 返回 text、entryIds、truncated 和 registry version。

TaskRouter 在执行时按 task kind 组合 instructions，并把 entry ids 和 version 放到结果 provenance。Desktop pluginInstructions.ts 目前以稳定映射和任务 metadata 提供 22 个插件的指令，但未确认已自动注册到 Daemon registry。

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
| skill ids/version | 当前没有统一记录 |
| cache hit/miss | Cache 工具统计已有，Task provenance 未统一接入 |
| checkpoint/artifact lineage | 局部字段存在，端到端关联待验证 |
| error code/message | 已有摘要；生产脱敏策略待验证 |

TaskRouter 的 sanitizeProvenance 会移除 thinking、reasoning、chainOfThought、cot 和 rawThinking。TaskModelHandler 也会移除完整 <think>。禁止把完整 Prompt、私有 CoT 或模型隐藏推理写入默认日志和持久化记录。

## 16. 插件边界和迁移

Desktop 的 first-party catalog 位于 inkpi-desktop/src/ai/tasks/pluginCatalog.ts，共 44 个 id，并由 architecture-ai.test.ts 与 src/core/pluginRegistry 对齐检查。

当前有 22 个插件组件通过 PluginHostContext.aiAssistant.runAnalysis 创建 plugin.<id>.analysis 任务。其余 22 个插件尚未完成从代码证据出发的 A–G 分类：

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
- 插件 AI 分析通过 createPluginAnalysisTask 和 runAnalysis；
- AI 结果不绕过 Desktop review/CAS 直接改变创作域。

44 个插件的完整分类、剩余迁移、所有 Legacy session/Agent AI 入口清理和其他文档更新尚未完成，因此 Phase 20–21 仍是局部状态。

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
~~~

已有 runner 可以检查 task status、output contract、required provenance 和 proposal approval；已有 long-context fixture、mutation helper 和 subjective score 接口。

Final 前必须加入 CI 并有可复现结果：

- dead-character reappearance；
- timeline contradiction；
- entity contradiction；
- missing payoff；
- invalid state transition；
- retrieval 错误；
- source-map/range 错误；
- Prompt/Context/Skill/Model Router mutation；
- 100 和 300 chapter context pruning、retrieval recall、cache hit rate；
- distillation checkpoint/recovery；
- 五个 Vertical Slice 的集成回归。

单元测试通过不等于 v1 Final。每次契约变更还必须通过 typecheck、lint、unit、architecture、RPC/integration 和相关 regression eval。

## 18. 当前一致性矩阵

| Phase / 能力 | 代码证据 | v1 状态 |
| --- | --- | --- |
| Phase 0 架构不变量 | RFC、Desktop/Runtime architecture tests | 局部；全仓库文档和旧 RPC 仍需清理 |
| Phase 1 canonical content | SemanticDocument、SourceMap、projection tests | 已有；复杂编辑器映射待扩展 |
| Phase 2 story model | StoryState、Provenance、StoryContext tests | 局部；持久化/完整提取待验证 |
| Phase 3–5 task contract/router | protocol task.ts、TaskRegistry、TaskRouter、RPC tests | 局部；schema/公开 execution RPC 待评估 |
| Phase 6 context pipeline | ContextPipeline、JitContextProvider | 局部；Desktop provider wiring 待验证 |
| Phase 7 creative layer | taskFactories、CreativeIntelligence | 已有本地路径 |
| Phase 8 five slices | verticalSlices、proposal、task handler tests | 局部；真实端到端待验证 |
| Phase 9 projection sync | DomainChangeSet、IndexedDB store、SQLite store | 局部；具体 materialized reducer 缺失 |
| Phase 10 Proposal/CAS | DomainProposal、ProposalLedger、Selection Toolbar | 局部；统一持久化/跨端待验证 |
| Phase 11 durable execution | checkpoint/execution stores、TaskRouter recovery | 局部；崩溃和重启演练待验证 |
| Phase 12 skills | ProgressiveSkillRuntime | 局部；四个 first-party skill manifest 待验证 |
| Phase 13 artifacts | ArtifactRuntime、IndexedDbArtifactStore | 局部；Daemon sync/RPC 待验证 |
| Phase 14 cache | ContextCache、LayeredContextCache | 局部；默认调用链未接入 |
| Phase 15 capability routing | CapabilityRouter、ModelCapabilities | 局部；TaskRouter integration 未接入 |
| Phase 16 instructions | InstructionRegistry、pluginInstructions | 局部；Desktop→Daemon registry wiring 待验证 |
| Phase 17 scheduler | TaskScheduler、TaskRouter events | 局部；scheduler 本身不 durable |
| Phase 18 evals | fixtures、EvalRunner、task evals | 局部；CI 和完整客观任务待补 |
| Phase 19 observability | observer、provenance sanitizer、task events | 局部；skill/cache/lineage/脱敏策略待验证 |
| Phase 20–21 plugins/legacy | 44 catalog、22 routed plugin、architecture guards | 未完成 |
| Phase 22 reliability review | 针对性测试入口 | 未完成全套演练 |
| Phase 23 final freeze | 本文件 | 条件冻结，禁止宣称 Final |

## 19. Final Freeze Checklist

以下清单全部完成并有测试或运行报告后，才能把本文件状态改为 Final：

- [ ] SemanticDocument、SourceMap 对所有支持的编辑器输入稳定；
- [ ] StoryState、Provenance 和 canonical fact 读写路径稳定；
- [ ] Continue、Rewrite、Continuity Audit、Deep Reasoning、Distillation 五个切片通过 Desktop ↔ Daemon 集成测试；
- [ ] DomainChangeSet 的 materialized projection reducer、幂等、乱序、checksum、snapshot 和离线恢复通过测试；
- [ ] Proposal → Review → CAS Commit → Undo 在 IndexedDB 上通过并发测试；
- [ ] Daemon crash、App restart、checkpoint corruption、partial workflow resume 有报告；
- [ ] Context provider registration、budget、fingerprint 和 overflow 行为稳定；
- [ ] 第一批四个 creative skill 有真实 manifest、lazy loading、ExtensionHost/ToolRegistry 注册测试；
- [ ] ArtifactStore、lineage 和导出边界稳定；
- [ ] 三层 Cache 接入真实调用链并有 hit/miss/invalidation 数据；
- [ ] CapabilityRouter 接入强制模型选择，并覆盖 capability mismatch；
- [ ] InstructionRegistry 统一 Desktop/Daemon 的 id/version/provenance；
- [ ] Evals 进入 CI，包含客观、主观、mutation 和长上下文回归；
- [ ] Observability 完成字段、采样、脱敏和无 raw CoT 验证；
- [ ] 44 个插件完成分类和迁移，Legacy AI 路径和过期接口文档清理；
- [ ] 完成 offline、network failure、stale proposal、duplicate task、model unavailable、invalid structured output、context overflow 和 cache invalidation 演练。
