import type {
  QualityGateIssue,
  QualityGateRule,
  WorkflowContext,
  WorkflowEventListener,
  WorkflowStageConfig
} from '@inkpi/protocol';
import type { TelemetryCollector } from '../telemetry/telemetry.js';

import { WorkflowEventBus } from './event-bus.js';
import { detectGateIssues } from './gate-detection.js';
import { GateRuleRegistry } from './gate-rule-registry.js';
import { RoleInvoker } from './role-invoker.js';
import { RoleRegistry } from './roles.js';
import { StageRegistry } from './stage-registry.js';
import { TelemetryTracer } from './telemetry-tracer.js';
import { WorkflowExecutor } from './workflow-executor.js';
import { genericWorkflowStrategy } from './workflow-strategy.js';
import type { WorkflowStrategy } from './workflow-strategy.js';
import type { WorkflowExecutionOptions } from './workflow-types.js';

export type {
  WorkflowStageHooks,
  WorkflowExecutionOptions
} from './workflow-types.js';

/**
 * 多 Agent 协作与工作流编排引擎。
 *
 * 本类只做**装配与公开 API**：阶段/规则注册表、事件总线、遥测跟踪、
 * 角色调用、执行策略各自是独立协作对象，阶段循环本身位于 `WorkflowExecutor`。
 * 这样职责单一，每一部分都能独立替换与测试。
 *
 * 对外只提供显式的 domain-neutral workflow API；创作领域行为通过
 * TaskHandler 或调用方注入的 stage 配置进入 Runtime Task Router。
 */
export class WorkflowCoordinator {
  public telemetry?: TelemetryCollector;

  private options: WorkflowExecutionOptions;
  private strategy: WorkflowStrategy;
  private invoker: RoleInvoker;
  private stages: StageRegistry;
  private gates: GateRuleRegistry;
  private roles: RoleRegistry;
  private events: WorkflowEventBus;
  private tracer: TelemetryTracer;
  private executor: WorkflowExecutor;

  constructor(options: WorkflowExecutionOptions = {}) {
    this.options = options;
    this.telemetry = options.telemetry;
    this.strategy = options.strategy ?? genericWorkflowStrategy;
    this.roles =
      options.roleRegistry ?? new RoleRegistry(options.initialRoles ? { initialRoles: options.initialRoles } : {});
    this.stages = new StageRegistry(options.stages || []);
    this.gates = new GateRuleRegistry(options.customGateRules || []);
    this.events = new WorkflowEventBus();
    this.tracer = new TelemetryTracer(() => this.telemetry);
    this.invoker = new RoleInvoker();
    this.executor = new WorkflowExecutor({
      events: this.events,
      stages: this.stages,
      gates: this.gates,
      roles: this.roles,
      telemetry: this.tracer,
      strategy: this.strategy,
      options: this.options,
      invoker: this.invoker
    });
  }

  /**
   * 动态注册或覆盖流水线阶段
   */
  public registerStage(config: WorkflowStageConfig): this {
    this.stages.register(config);
    return this;
  }

  /**
   * 动态添加质量门禁规则
   */
  public addGateRule(rule: QualityGateRule): this {
    this.gates.add(rule);
    return this;
  }

  /**
   * 订阅工作流事件流
   */
  public subscribe(listener: WorkflowEventListener): () => void {
    return this.events.subscribe(listener);
  }

  /**
   * 纯规则驱动的质量门禁自动检测 (100% 领域中立)
   */
  public detectGateIssues(content: string, context?: unknown): QualityGateIssue[] {
    return detectGateIssues(content, this.gates.all(), context);
  }

  public detectQualityGateIssues(content: string, context?: unknown): QualityGateIssue[] {
    return this.detectGateIssues(content, context);
  }

  /**
   * 执行全流程多 Agent 动态工作流
   */
  public async runWorkflow(initialCtx: Partial<WorkflowContext>): Promise<WorkflowContext> {
    return this.executor.execute(initialCtx, this.stages.list());
  }
}
