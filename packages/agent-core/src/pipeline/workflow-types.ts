import type { ModelConfig } from '@inkpi/ai';
import type {
  AgentRoleConfig,
  PipelineHooks,
  QualityGateDecision,
  QualityGateHandler,
  QualityGateIssue,
  QualityGateRule,
  RuntimeState,
  WorkflowContext,
  WorkflowStageConfig,
  WorkflowStateAdapter
} from '@inkpi/protocol';
import type { Clock } from '../ports/index.js';
import type { TelemetryCollector } from '../telemetry/telemetry.js';
import type { RoleRegistry } from './roles.js';
import type { WorkflowStrategy } from './workflow-strategy.js';

export interface WorkflowStageHooks {
  onBeforeStage?: (stageId: string, ctx: WorkflowContext, currentPrompt: string) => Promise<string | undefined>;
  onStageProgress?: (stageId: string, delta: string) => void;
  onAfterStage?: (stageId: string, output: string, ctx: WorkflowContext) => Promise<string | undefined>;
}

/**
 * 工作流执行选项。
 *
 * 与协调器实现分离：执行器只依赖本类型，不依赖 `coordinator.ts`，
 * 从而打断"协调器 ↔ 执行器"的循环依赖。
 */
export interface WorkflowExecutionOptions {
  model?: ModelConfig;
  customExecutor?: (role: string, systemPrompt: string, userPrompt: string, signal?: AbortSignal) => Promise<string>;
  telemetry?: TelemetryCollector;
  clock?: Clock;
  hooks?: PipelineHooks[];
  stageHooks?: WorkflowStageHooks;
  signal?: AbortSignal;
  enableQualityGate?: boolean;
  qualityGateHandler?: QualityGateHandler;
  customGateRules?: QualityGateRule<WorkflowContext>[];
  stages?: WorkflowStageConfig[];
  /** 注入已构造好的 RoleRegistry 实例（优先于 initialRoles） */
  roleRegistry?: RoleRegistry;
  /** 初始角色字典，由 coordinator 内部构建 RoleRegistry（当 roleRegistry 未传入时生效） */
  initialRoles?: Record<string, AgentRoleConfig>;
  /** Caller-owned opaque state adapter; the Runtime supplies no domain default. */
  stateAdapter?: WorkflowStateAdapter;
  /** Optional caller-owned state extractor; generic workflows never infer state. */
  stateExtractor?: (output: string, ctx: WorkflowContext) => RuntimeState | Partial<RuntimeState>;
  /** Optional caller-owned state formatter; generic workflows never format domain state by default. */
  stateFormatter?: (state: RuntimeState) => string;
  /**
   * @deprecated Compatibility alias for stateExtractor. It remains an
   * explicit injection point and is never installed as a Runtime default.
   */
  ledgerExtractor?: (output: string, ctx: WorkflowContext) => RuntimeState | Partial<RuntimeState>;
  /** @deprecated Compatibility alias for stateFormatter. */
  ledgerFormatter?: (state: RuntimeState) => string;
  /**
   * 可选执行策略。默认使用唯一的 domain-neutral generic strategy。
   */
  strategy?: WorkflowStrategy;
}
