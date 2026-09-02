import type {
  StateLedger,
  PipelineHooks,
  QualityGateRule,
  QualityGateIssue,
  QualityGateDecision,
  QualityGateHandler,
  WorkflowStageConfig,
  WorkflowContext,
  WorkflowEvent,
  WorkflowEventListener,
  AgentRoleConfig
} from '@inkpi/protocol';
import type { ModelConfig } from '@inkpi/ai';
import type { TelemetryCollector } from '../telemetry/telemetry.js';
import type { RoleRegistry } from './roles.js';
import type { WorkflowStrategy } from './workflow-strategy.js';

export type PipelineStage = 'outline' | 'draft' | 'audit' | 'polish' | string;
export type PlotGateType = string;
export type PlotGateRule = QualityGateRule;
export type PlotGateIssue = QualityGateIssue;
export type PlotGateDecision = QualityGateDecision;
export type PlotGateHandler = QualityGateHandler;

export interface WorkflowStageHooks {
  onBeforeStage?: (stageId: string, ctx: WorkflowContext, currentPrompt: string) => Promise<string | void>;
  onStageProgress?: (stageId: string, delta: string) => void;
  onAfterStage?: (stageId: string, output: string, ctx: WorkflowContext) => Promise<string | void>;
}

/**
 * 工作流执行选项。
 *
 * 与协调器实现分离：执行器只依赖本类型，不依赖 `coordinator.ts`，
 * 从而打断"协调器 ↔ 执行器"的循环依赖。
 */
export interface PipelineExecutionOptions {
  model?: ModelConfig;
  customExecutor?: (role: string, systemPrompt: string, userPrompt: string, signal?: AbortSignal) => Promise<string>;
  telemetry?: TelemetryCollector;
  hooks?: PipelineHooks[];
  stageHooks?: WorkflowStageHooks;
  signal?: AbortSignal;
  enablePlotGate?: boolean;
  enableQualityGate?: boolean;
  plotGateHandler?: PlotGateHandler;
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
   * 仅供旧 pipeline.run 兼容字段和事件名称；通用工作流不启用。
   * @deprecated 这只是 `strategy: legacyPipelineWorkflowStrategy` 的语法糖。
   * 新增执行模式请直接注入 `strategy`，不要再扩展本联合类型。
   */
  compatibilityMode?: 'legacy-pipeline';
  /**
   * 直接注入执行策略，优先于 `compatibilityMode`。
   * 自定义模式（例如新增一种事件命名约定）无需修改协调器即可生效。
   */
  strategy?: WorkflowStrategy;
}

export type PipelineContext = WorkflowContext;
export type PipelineEvent = WorkflowEvent;
export type PipelineEventListener = WorkflowEventListener;
