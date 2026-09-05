# 上游持久性不变量审计（pi 0.85.x 运行时重写 → InkPi）

> 日期：2026-09-05
> 基线：本仓库 `master@ed4994f`（已含 `feat(upstream-sync): align with pi v0.85.1 improvements and resilience fixes`）。
> 注意：当前 worktree 分支 `workbuddy/master-69a60744` 停在 `059b8b9`，落后 master 一个提交；本审计全部基于 `ed4994f` 的代码内容（经 `git show ed4994f:<path>` 核验）。
> 上游参照：earendil-works/pi `v0.84.4..v0.85.1` 的运行时重写设计文档：
> - `packages/agent/docs/tool-durability.md`（工具持久性：outcome_ready 两阶段放置）
> - `packages/agent/docs/assistant-durability.md`（助手流式帧部分持久化）
> - `packages/agent/docs/values.md`（绑定类型地址 value/list）
> - `packages/agent/docs/runtime-simplification.md`（运行时简化与显式延续结果）

> [!IMPORTANT]
> **实施状态（2026-09-05 当日更新）**：本审计 §2 中的 **P0 与全部 P1/P2 缺口已在后续提交中修复**：
> - P0 源序放置：`tool_execution` 条目携带 `sourceIndex` + 归约缓冲重排（§1.1 方案 a+b 混合）；
> - P1 流式帧持久化：新增 `turn/assistant-frames.ts`（`AssistantFrameEncoder` / `reduceAssistantFrames`）+ `assistant_frame` journal 条目；
> - P1 replay 合约：`AgentTool.replay: 'safe'|'never'`、dispatcher fencing、`planInterruptedRecovery` + `synthesizeInterruptedToolResult`、SessionRegistry 恢复自动合成；
> - P2 进度 checkpoint：`ToolUpdateOptions.checkpoint` + `tool_progress` journal 条目；
> - P2 预保留 invocationId：`tool_execution` 条目 id = invocationId（对齐上游 "invocationId = resultEntryId"）。
> 验证：`tsc -b` 通过；vitest 453/453 通过（含新增 `tests/durability-invariants.test.ts` 11 例）。P3（ContinueOperationResult 富化）按 §2 结论未实施——现状无缺陷。
> value/list 评估结论不变：**不引入**（§3）。
> **Lane 逐行比对已完成（2026-09-05 追加，见 §6）**：结论为无需代码改动，`storage/lanes.ts` 与 pi 的 Lane 是同名异义概念；三条触发条件式待办见 §6.4。

---

## 0. 一句话结论

pi 重写的内核不是"换架构"，而是把**持久性（durability）推到极致**：意图先行、结算即持久化、源序放置、结算不重放。InkPi 的事件溯源骨架已经满足其中一半（意图先行、结算即持久化、显式延续），**真正的缺口集中在"恢复路径"**：恢复后工具结果会按完成序而非源序物化（可能导致 provider 400）、工具无 replay 合约与 fencing、助手流式过程零持久化。value/list 类型地址层**不建议引入**（详见 §3）。

---

## 1. 不变量清单与逐条验证

图例：✅ 已满足 · 🟡 部分满足 · ❌ 缺失 · ⚪ 不适用

| # | 不变量（来源） | InkPi 现状 | 证据 |
|---|---|---|---|
| A1 | **意图先行**：effect 执行前先持久化已验证的意图与参数（tool-durability "effect sandwich"） | ✅ | `tool-dispatcher.ts`：`operation_intent` 在执行前 append；`stream-invoker.ts:24` 流调用前 append |
| A2 | **结算即持久化**：每个工具 settle 后立即写最终结果，不等批次 | ✅ | `tool-dispatcher.ts` `executeOne`：settle 后立即 `journal.append('operation_settlement')` + `journal.append('tool_execution')`，非批量 |
| A3 | **源序放置**：结果进入会话的顺序 = assistant 源序，与完成序解耦（outcome_ready → completed） | 🟡→❌ | 详见表后 §1.1，**本次审计最重要的发现** |
| A4 | **结算不重放**：结果一旦持久化，恢复时绝不重跑外部副作用；有 `replay: "safe"|"never"` 合约与迟到写 fencing | ❌ | `session-reducer.ts` `detectAndMarkInterruptedOperations` 仅把 running/pending 标为 `interrupted`；`ToolRegistry`/`Tool` 无 replay 标注 |
| A5 | **进度 checkpoint**：工具可请求持久化"完整有界"进度快照（观察性数据，不作完成证明） | ❌ | `tool_execution_update` 仅 live emit（`tool-dispatcher.ts` onUpdate 回调），不落 journal |
| A6 | **稳定调用身份**：invocationId = 预保留的 resultEntryId，与 provider 的 toolCallId 分离（后者可能被复用） | 🟡 | 直接用 `call.id`（provider toolCallId）作身份；journal `entry.id` 在结算时生成，非预保留 |
| B1 | **助手流式部分持久化**：流式期间持久化紧凑可重放帧；settlement 时原子清理（assistant-durability） | ❌ | `stream-invoker.ts` 只在流结束后 append `agent_turn`；全程零帧持久化。现有 `retryAssistantStream` 是整轮重试，非断点续传 |
| B2 | **帧是辅助数据**：缺失合法、不证明成败、不选重启点、base restore 不读它 | ⚪ | 依赖 B1，若引入需一并遵守 |
| C1 | **绑定类型地址** value<T>/list<T>（values.md） | ⚪ 不引入 | 见 §3 评估结论 |
| C2 | **list 只追加 + 全局事务 seq 分页** | ✅ | `DocumentDelta.id` 自增、`getDeltas(documentId, afterId)` 闭区间语义与 pi 目标一致 |
| C3 | **值/列表与 entries 原子提交** | 🟡 | `IDb.transaction` 存在（storage 端口）；`session-backends` 三后端无跨条目事务原语（`loadEntries` 只是批量 append） |
| D1 | **显式延续结果**：以带类型的结果对象取代隐式 undefined 表达"是否继续/取消"（runtime-simplification） | ✅ | `TurnFinalizer.finalize` 返回显式 boolean；`TerminationFlag` 为显式可变标志，无隐式 undefined。pi 的 `ContinueOperationResult<T>`（含 `cancel_requested` 臂）是可选增强，非缺陷 |
| D2 | **过程四步**：prepare immutable input → publish intent → perform effect → publish outcome | ✅ | turn 四段管线（ContextTransformer→StreamInvoker→ToolDispatcher→TurnFinalizer）已天然对应该结构 |
| D3 | **不引入通用 Procedure 接口/调度器/门面** | ✅ | 现有四段管线是显式类组合，无过度抽象，与 pi 该原则同向 |

### 1.1 A3 详述：恢复后工具结果按"完成序"物化（最重要的缺口）

**现象链**（`ed4994f` 代码实证）：

1. 并行模式下 `runWithConcurrency` 用 `Promise.all`，批内**返回**顺序是源序（正确）；
2. 但 `ctx.state.messages.push(toolRes)` 与 `message_start/end` 事件在**整个批次完成后**才执行（`tool-dispatcher.ts` dispatch 内 for 循环）——A 未完成时，B/C 的结果已写入 journal 却不在会话状态中；
3. **journal 是按结算顺序（完成序）追加的**：B、C 先于 A；
4. 恢复路径 `reduceSessionEntry` 对 `tool_execution` 的处理是 `next.messages.push(toolMsg)`——**按 journal 顺序物化**，且 journal 条目中没有任何 sourceIndex/位置信息；
5. 结果：**恢复后的会话里，toolResult 消息顺序 = 完成序，而 assistant 消息的 toolCalls 是源序**。Anthropic Messages 等严格校验 tool_result 顺序与 tool_use 一致，恢复后的下一轮请求可能直接被 provider 拒绝；即使 provider 宽容，语义上也是错的。

这正是 pi 用 `outcome_ready`（结算持久化）与 `completed`（源序放置）两个状态解耦"完成序 vs 源序"要解决的问题。InkPi 的"结算即持久化"已做到一半，缺的正是"放置"这另一半。

**修复建议（P0，改动面小）**：

- 方案 a（最小）：`tool_execution` 的 journal payload 已含 `toolCallId`。在 `reduceSessionEntry` 中**缓冲** toolResult，遇到下一条 `agent_turn`/`user_message`（或归约结束）时，按其前面最近一条 assistant 消息 `content` 中 toolCall 的出现顺序重排后一次性 push；
- 方案 b（对齐上游语义）：journal `tool_execution` 条目增加 `sourceIndex` 字段（assistant content 中的下标），归约时按 `(assistantEntryId, sourceIndex)` 排序物化；
- 方案 c（完整对齐）：引入 `pendingEntry` 暂存 + 显式 `outcome_ready → completed` 两段事务——改动面大，建议仅在方案 a/b 不足时再考虑。

---

## 2. 其余缺口的修复建议（按优先级）

| 优先级 | 缺口 | 建议做法 | 对应上游参照 |
|---|---|---|---|
| P0 | 恢复后源序放置 | §1.1 方案 a 或 b | tool-durability.md（outcome_ready/placement） |
| P1 | 助手流式零持久化（与 README"断流恢复"承诺不符） | 借鉴 `AssistantMessageFrame`：给 `AssistantEventStream` 事件定义紧凑帧编码器（块起始快照 + delta 前缀裁剪），流式期间逐帧 append 到 journal 专用条目类型；settlement 时原子清理；恢复时 reduce 帧重建 partial。**不要**每事件克隆全量消息 | assistant-durability.md；`packages/ai/src/utils/assistant-message-frame.ts` |
| P1 | 工具无 replay 合约/fencing | `ToolRegistry` 注册项增加 `replay: 'safe' \| 'never'`；恢复时对 `interrupted` 且**无 settlement** 的调用：safe → 允许重放（沿用原 invocationId），never → 合成"结果未知，请人工确认"的 isError 结果，绝不重跑；已有 settlement 的一律不重放 | tool-durability.md（状态机 + unsafe orphan synthesis） |
| P2 | 进度 checkpoint 缺失 | `tool_execution_update` 回调增加 `checkpoint?: true` 选项；工具自调节流（bash 类参考 100ms live / 2s checkpoint、50KiB 有界快照）；journal 新增 `tool_progress` 条目类型，仅作观察数据 | tool-durability.md（Partial output / Bash policy） |
| P2 | 调用身份非预保留 | 派发前先生成 `invocationId`（`op_tool_*` 已有类似约定，可将其升级为 journal entry 预保留 id），journal 条目携带它而非依赖 provider toolCallId | tool-durability.md（Durable identities） |
| P3 | `ContinueOperationResult` 富化 | 可选：`TurnFinalizer.finalize` 返回 `{ kind: 'continue' } \| { kind: 'stop', reason } \| { kind: 'cancel_requested' }` 标签联合。当前 boolean 无缺陷，仅在需要向 UI 区分"取消请求"与"自然停止"时再做 | runtime-simplification.md |

---

## 3. value/list 类型绑定地址层评估（任务 3 结论）

**结论：不引入。** 理由：

1. pi 的 `value<T>(ns, key)` 是为它的 Lane/Drive 运行时服务的**通用持久化原语**——任意应用态标量与追加列表，跨 Memory/JSONL/SQLite 行为一致。InkPi 的对应需求已被**领域类型化端口**覆盖：`ISessionBackend`（会话日志/快照/delta）与 `IRepository`（工作区/文档/操作记录）。通用 KV 抽象在你这里会退化成"伪灵活性"，违背你"五大工程不变量"里对显式契约的坚持。
2. 逐项对照 values.md 的 9 条目标：
   - 地址一次绑定、编译期类型 → 你的端口方法签名即类型（更严格）；
   - 无全局注册表 → 你的领域接口同样没有；
   - list 只追加 + seq 分页 → `DocumentDelta.id` 自增 + `getDeltas(afterId)` **已满足**；
   - 原子提交 → `IDb.transaction` 已有；`session-backends` 缺跨条目事务，但 `loadEntries`（你 sync 中新增）已覆盖最主要的批量还原场景；
   - 三后端逻辑一致 → 你已有 LSP conformance 测试（`tests/session-backends-conformance.test.ts`，含刚新增的 loadEntries 一致性）。
3. 若未来 InkPi 出现"应用任意状态需要会话级持久化"的真实需求（例如插件/扩展宿主状态），再考虑引入受约束的 `list<T>(namespace, key)` 追加原语，且届时应作为 `ISessionBackend` 的**新方法**而非通用地址层。

---

## 4. 明确不移植项（维持前次结论，补充理由）

- **Drive/Lane 机制细节、13-leaf structural reducer、mobile-handoff 工作包**：pi 的工程实现细节，与 InkPi 六边形架构的等价物（`storage/lanes.ts`、`pipeline/*`）重叠但不同构；照搬将破坏依赖方向 ratchet。
- **`assertCompleteFrame` 移除等 protocol 内部重构**：InkPi 的 CBOR 实现独立，无对应债务。
- **Cloudflare AI Gateway binding 变更**：InkPi 无此传输层。

---

## 5. 与既有 upstream-sync（ed4994f）的关系

`ed4994f` 已吸收的是"行为层"修复（截断拦截、压缩边界、会话分享隔离、loadEntries 等）；本审计指向的三个缺口（源序放置、replay 合约、流式帧持久化）属于"恢复语义层"，**两者正交互补**。建议下一轮 upstream-sync 以本文件 §2 的 P0/P1 为范围立项。

---

## 6. Lane 逐行比对（WP06 / WP09 → InkPi）

> 审计初版标注"⚠️ 部分重叠，需逐行比对"的最后一项，本节补全。
> 素材：pi `packages/agent/src/harness/runtime/lane.ts`（2012 行）、`docs/work-packages/06-session-branch-lane-separation.md`（734 行）、`docs/work-packages/09-lane-snapshot-settled-tools.md`（517 行）；InkPi `packages/storage/src/lanes.ts`、`packages/agent-core/src/tree.ts`、`packages/storage/src/mutation-queue.ts`。

### 6.1 首要发现：命名撞车，语义不同构

InkPi 的 `storage/lanes.ts`（`LaneManager`）**不是** pi 的 "Lane" 对应物。它是**创作文档域**的概念：workspace 下的泳道容器 + 文档分支游标（`BranchTip.headSnapshotVersion/lastDeltaId`）+ git 式 fork/merge（含 fork 基线 CAS 冲突检测）。消费方仅 `db.ts`/`ddl.ts` 与存储一致性测试，与 agent 运行时无耦合。

pi 的 "Lane" 是**会话运行时**概念，且 WP06 已将其拆解为四个显式概念：`Session`（全局持久数据 + 单一无 key 变更线）→ `Branch`（纯数据路径 + tip）→ `AgentLane`（Branch + agent 配置/状态/操作）→ `AgentHarness`（纯组合管理器，禁止继承）。`lane.ts` 那 2012 行里真正的大头是 Drive 执行细节（driveOperation、structural preparation），不是 lane 本身。

因此逐行比对必须按"职责切片"进行，而非按文件名对应。

### 6.2 职责切片对照表

| pi 职责切片 | InkPi 对应物 | 比对结论 |
|---|---|---|
| **Branch tip 持久化**（`branchTip` 值地址、tip 移动与 entry 追加同事务） | `LaneManager.branch_tips` + `SessionTree`（内存树、tip 移动） | ✅ 等效满足。且 InkPi 的 `forkLane`/`mergeLane` 带 fork 基线 CAS（merge 时校验 target 未变），比 pi §7 的 session fork 语义**更严格**——pi fork 排除 operation/pending 状态，InkPi 直接拒绝并发目标变更 |
| **Session 单一 mutation line**（无 key、串行化全部变更回调；读绕过线；effect 留在线外） | **无显式对应物** | ✅ 判定不需要。理由：① Node 单进程事件循环 + 每 session 单 `Agent` 实例，变更天然串行；② `journal.append` 是同步调用，不存在"回调中途 await 交错"这一 pi 要防的核心病灶；③ 文档域的并发写已有 `DocumentMutationQueue`（资源粒度串行锁）覆盖。注意 pi WP06 §10 明确**排除 keyed mutation lines**，而 InkPi 的 keyed 队列在文档域是合理需求（多 agent 并发写不同文档），两者不矛盾——但**不要**把它套到会话域 |
| **AgentLane 配置/状态持久化**（`laneConfig`/`laneState`/`laneLastResult` 作为绑定值地址） | 会话配置走 `SessionEntry`/journal 条目（model、thinkingLevel 等） | ✅ 等效满足（与 §3 value/list 结论一致：领域类型化条目优于通用值地址） |
| **无隐式 main**（§5.1：fresh Session 零 Branch，不预置 main tip） | `SessionTree.rootId` 初始 `null`，首条消息才确立根（`tree.ts:20,63`） | ✅ 天然满足，无隐式主分支 |
| **Branch 完备性 = tip 存在**（§5.2：partial 组合 fault） | `setBranchTip` 校验 lane/document 存在性与 workspace 归属，fork 单事务 | ✅ 等效满足 |
| **WP09 投影不变量**（settled-but-unplaced 工具在快照中不可消失；placement 是源前缀 flush 而非全屏障；`entry_added` 时移除而非 `turn_end` 清空） | 持久化层已被 P0 修复等效覆盖（`pendingToolResults` 缓冲 + 源序重排）；UI 快照层无 `LaneSnapshot.runningTools` 等价物 | ✅ 现状无此 bug 面；将来做重连投影时按 §6.4 触发条件采纳 |

### 6.3 明确排除项（比对后维持）

- **`Session.mutate()` 显式变更线**：机制不引入（§6.2 行 2）。pi 引入它是为了多 Lane 并发 command 与"回调内 await 后再提交"的交错防护；InkPi 的 agent 事件流是顺序驱动的，`shouldTerminate`→append→settle 全程无跨 await 的读-改-写窗口（`journal.append` 同步）。
- **AgentLane/Harness 四层拆分**：InkPi 的 `Agent`（agent-core）+ `SessionRegistry`（rpc）已承担同等职责且边界清晰，拆分是照搬 pi 的结构而非决策。
- **Drive/lane 执行细节**（`driveOperation`、structural preparation、fence）：继续排除（§4 维持）。

### 6.4 触发条件式待办（仅在未来出现对应需求时启用）

1. **会话域并发写**：若将来出现"多 agent 同时写同一会话"或"RPC 变更回调内跨 await 后再 append"的场景，再引入 pi 式单一会话变更线（届时应作为 `agent-core` 的显式端口，而非复用文档域的 `DocumentMutationQueue`）。
2. **断线重连/UI 快照投影**：若做 `LaneSnapshot` 式投影，采纳 WP09 三条不变量——`runningTools` 覆盖 `effect_pending` 与 `outcome_ready` 两态、placement 按源前缀逐个 flush、仅在 `entry_added` 时移除对应调用。
3. **泳道/会话统一**：若产品上需要"一个泳道 = 一条会话分支"的双向绑定，`LaneManager` 需与 `SessionTree` 建立外键关联——这是**产品决策**，不是上游对齐项。

### 6.5 小结

Lane 比对闭环：**无需任何代码改动**。InkPi 在 Branch 持久化、无隐式 main、完备性校验三个决策点上与 pi 同源同向（部分点更严格）；pi 的变更线与四层拆分是其多 Lane 运行时的专属机制，InkPi 以更小的架构面积达到了同等正确性。至此本审计全部开放项关闭。

---

*本文件为分析文档。P0–P2 修复相关的生产代码改动见提交 `e223f93`；其余结论基于 `ed4994f` 与 pi `v0.85.1`（da840b621）源码实证。*
