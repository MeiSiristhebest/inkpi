import type { ModelConfig } from '@inkpi/ai';
import type {
  AgentRoleConfig,
  PipelineHooks,
  QualityGateDecision,
  QualityGateHandler,
  QualityGateIssue,
  QualityGateRule,
  StateLedger,
  WorkflowContext,
  WorkflowStageConfig
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
  customGateRules?: QualityGateRule[];
  stages?: WorkflowStageConfig[];
  /** 注入已构造好的 RoleRegistry 实例（优先于 initialRoles） */
  roleRegistry?: RoleRegistry;
  /** 初始角色字典，由 coordinator 内部构建 RoleRegistry（当 roleRegistry 未传入时生效） */
  initialRoles?: Record<string, AgentRoleConfig>;
  /** 可选的领域状态抽取器；通用工作流不会自行推断状态。 */
  ledgerExtractor?: (output: string, ctx: WorkflowContext) => StateLedger | Partial<StateLedger>;
  /** 可选的领域状态格式化器；通用工作流不会自动注入账本。 */
  ledgerFormatter?: (ledger: StateLedger) => string;
  /**
   * 可选执行策略。默认使用唯一的 domain-neutral generic strategy。
   */
  strategy?: WorkflowStrategy;
}
