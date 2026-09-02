import type {
  StateLedger,
  QualityGateIssue,
  QualityGateRule,
  WorkflowContext,
  WorkflowEventListener,
  WorkflowStageConfig
} from '@inkpi/protocol';
import type { TelemetryCollector } from '../telemetry/telemetry.js';

import { RoleRegistry } from './roles.js';
import {
  createLegacyNarrativeStages,
  createNarrativeEntitySafetyRules,
  createScreenplayGateRules,
  createShortDramaGateRules,
  createStandardEntitySafetyRules,
  createVisualNovelGateRules
} from './legacy-narrative.js';
import { extractNovelStateLedger, formatNovelStateLedger } from '../compaction/state-ledger.js';
import { detectGateIssues } from './gate-detection.js';
import { legacyPipelineWorkflowStrategy, resolveWorkflowStrategy } from './workflow-strategy.js';
import type { WorkflowStrategy } from './workflow-strategy.js';
import { StageRegistry, mergeStageLists } from './stage-registry.js';
import { GateRuleRegistry } from './gate-rule-registry.js';
import { WorkflowEventBus } from './event-bus.js';
import { TelemetryTracer } from './telemetry-tracer.js';
import { RoleInvoker } from './role-invoker.js';
import { WorkflowExecutor } from './workflow-executor.js';
import type { PipelineExecutionOptions } from './workflow-types.js';

export type {
  PipelineStage,
  PlotGateType,
  PlotGateRule,
  PlotGateIssue,
  PlotGateDecision,
  PlotGateHandler,
  WorkflowStageHooks,
  PipelineExecutionOptions,
  PipelineContext,
  PipelineEvent,
  PipelineEventListener
} from './workflow-types.js';

/**
 * 标准实体安全与破坏性变动门禁规则
 */
export {
  createLegacyNarrativeStages,
  createNarrativeEntitySafetyRules,
  createScreenplayGateRules,
  createShortDramaGateRules,
  createStandardEntitySafetyRules,
  createVisualNovelGateRules
} from './legacy-narrative.js';

/**
 * 多 Agent 协作与工作流编排引擎。
 *
 * 本类只做**装配与公开 API**：阶段/规则注册表、事件总线、遥测跟踪、
 * 角色调用、执行策略各自是独立协作对象，阶段循环本身位于 `WorkflowExecutor`。
 * 这样职责单一，每一部分都能独立替换与测试。
 *
 * 对外行为与拆分前逐字一致，包括所有遗留别名（见文件末尾）。
 */
export class WorkflowCoordinator {
  public telemetry?: TelemetryCollector;

  private options: PipelineExecutionOptions;
  private strategy: WorkflowStrategy;
  private invoker: RoleInvoker;
  private stages: StageRegistry;
  private gates: GateRuleRegistry;
  private roles: RoleRegistry;
  private events: WorkflowEventBus;
  private tracer: TelemetryTracer;
  private executor: WorkflowExecutor;

  constructor(options: PipelineExecutionOptions = {}) {
    this.options = options;
    this.telemetry = options.telemetry;
    this.strategy = options.strategy ?? resolveWorkflowStrategy(options.compatibilityMode);
    this.roles =
      options.roleRegistry ??
      new RoleRegistry(options.initialRoles ? { initialRoles: options.initialRoles } : {});
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

  private async emit(event: Parameters<WorkflowEventListener>[0]): Promise<void> {
    return this.events.emit(event);
  }

  /**
   * 纯规则驱动的质量门禁自动检测 (100% 领域中立)
   */
  public detectPlotGateIssues(
    content: string,
    ledger?: StateLedger,
    context?: any
  ): (QualityGateIssue & { entityOrEntity?: string })[] {
    return detectGateIssues(content, this.gates.all(), ledger, context).map((i) => ({ ...i }));
  }

  public detectGateIssues(content: string, ledger?: StateLedger, context?: any): QualityGateIssue[] {
    return this.detectPlotGateIssues(content, ledger, context);
  }

  public detectQualityGateIssues(content: string, ledger?: StateLedger, context?: any): QualityGateIssue[] {
    return this.detectPlotGateIssues(content, ledger, context);
  }

  /**
   * 执行全流程多 Agent 动态工作流
   */
  public async runWorkflow(initialCtx: Partial<WorkflowContext>): Promise<WorkflowContext> {
    return this.executor.execute(initialCtx, this.stages.list());
  }

  /**
   * 向后兼容快捷调用方法：以遗留叙事阶段序列与兼容策略执行一次流水线。
   */
  public async runPipeline(
    bookTitle: string,
    chapterTitle: string,
    userPrompt: string,
    initialLedger?: StateLedger
  ): Promise<WorkflowContext> {
    const legacyOptions: PipelineExecutionOptions = {
      ...this.options,
      compatibilityMode: 'legacy-pipeline',
      enableQualityGate: this.options.enableQualityGate,
      customGateRules: [
        ...createStandardEntitySafetyRules(),
        ...(this.options.customGateRules || [])
      ],
      ledgerExtractor: (output) => extractNovelStateLedger([
        { role: 'assistant', content: [{ type: 'text', text: output }] } as any
      ]),
      ledgerFormatter: formatNovelStateLedger
    };

    const legacyStages = mergeStageLists(createLegacyNarrativeStages(), this.stages.list());

    const forwardingBus = new WorkflowEventBus();
    forwardingBus.subscribe((event) => this.emit(event));

    const legacyExecutor = new WorkflowExecutor({
      events: forwardingBus,
      stages: new StageRegistry(legacyStages),
      gates: new GateRuleRegistry(legacyOptions.customGateRules || []),
      roles:
        legacyOptions.roleRegistry ??
        new RoleRegistry(
          legacyOptions.initialRoles ? { initialRoles: legacyOptions.initialRoles } : {}
        ),
      telemetry: this.tracer,
      strategy: legacyPipelineWorkflowStrategy,
      options: legacyOptions,
      invoker: this.invoker
    });

    return legacyExecutor.execute(
      {
        bookTitle,
        title: bookTitle,
        chapterTitle,
        sectionTitle: chapterTitle,
        userPrompt,
        stateLedger: initialLedger
      },
      legacyStages
    );
  }
}

// 兼容别名（NovelCollaborativePipeline / CollaborativePipeline / PipelineCoordinator）
// 已集中迁移至 src/deprecations.ts。
