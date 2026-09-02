import type { QualityGateHandler, Usage, WorkflowContext, WorkflowStageConfig } from '@inkpi/protocol';
import type { WorkflowEventBus } from './event-bus.js';
import { detectGateIssues } from './gate-detection.js';
import type { GateRuleRegistry } from './gate-rule-registry.js';
import { emptyLedger, mergeLedgers } from './ledger-merge.js';
import type { RoleInvoker } from './role-invoker.js';
import type { RoleRegistry } from './roles.js';
import { type StageRegistry, resolveStageRole, resolveStageRoleId } from './stage-registry.js';
import type { TelemetrySpanHandle } from './telemetry-tracer.js';
import type { TelemetryTracer } from './telemetry-tracer.js';
import type { WorkflowStrategy } from './workflow-strategy.js';
import type { PipelineExecutionOptions } from './workflow-types.js';

export interface WorkflowExecutorDeps {
  events: WorkflowEventBus;
  stages: StageRegistry;
  gates: GateRuleRegistry;
  roles: RoleRegistry;
  telemetry: TelemetryTracer;
  strategy: WorkflowStrategy;
  options: PipelineExecutionOptions;
  invoker: RoleInvoker;
}

/** 阶段执行期间的遥测句柄，供门禁拒绝时以失败原因收尾。 */
interface StageTrace {
  span?: TelemetrySpanHandle;
  usage?: Usage;
}

/**
 * 工作流执行器：负责阶段循环本身。
 *
 * 协调器只负责装配与公开 API，执行细节（提示词装配、角色调用、门禁评估、
 * 产出收尾）全部落在本类。每个环节是一个独立方法，便于单独测试与替换。
 */
export class WorkflowExecutor {
  private readonly events: WorkflowEventBus;
  private readonly stages: StageRegistry;
  private readonly gates: GateRuleRegistry;
  private readonly roles: RoleRegistry;
  private readonly telemetry: TelemetryTracer;
  private readonly strategy: WorkflowStrategy;
  private readonly options: PipelineExecutionOptions;
  private readonly invoker: RoleInvoker;

  constructor(deps: WorkflowExecutorDeps) {
    this.events = deps.events;
    this.stages = deps.stages;
    this.gates = deps.gates;
    this.roles = deps.roles;
    this.telemetry = deps.telemetry;
    this.strategy = deps.strategy;
    this.options = deps.options;
    this.invoker = deps.invoker;
  }

  /**
   * 顺序执行阶段列表并返回最终上下文。
   *
   * @param stageList 显式指定阶段序列；缺省取注册表当前内容。
   *                  `runPipeline` 用它传入叠加后的遗留阶段序列。
   */
  public async execute(
    initialCtx: Partial<WorkflowContext>,
    stageList?: WorkflowStageConfig[]
  ): Promise<WorkflowContext> {
    const stages = stageList ?? this.stages.list();
    const ctx = this.prepareContext(initialCtx);
    const isGateActive = Boolean(this.options.enablePlotGate || this.options.enableQualityGate);

    for (const stage of stages) {
      await this.runStage(stage, ctx, isGateActive);
    }

    await this.events.emit({ type: 'pipeline_complete', result: ctx });
    return ctx;
  }

  private prepareContext(initialCtx: Partial<WorkflowContext>): WorkflowContext {
    return {
      ...initialCtx,
      userPrompt: initialCtx.userPrompt ?? '',
      stateLedger: initialCtx.stateLedger ?? emptyLedger(),
      stageOutputs: { ...(initialCtx.stageOutputs || {}) },
      stageLogs: [...(initialCtx.stageLogs || [])]
    };
  }

  private async runStage(stage: WorkflowStageConfig, ctx: WorkflowContext, isGateActive: boolean): Promise<void> {
    this.throwIfAborted(this.options.signal, stage.id);

    const roleConfig = resolveStageRole(stage, this.roles);
    const roleId = resolveStageRoleId(stage);

    const span = this.telemetry.startStage(stage.name, stage.id, roleConfig.role);
    await this.events.emit({
      type: 'stage_start',
      stage: stage.id,
      stageId: stage.id,
      role: roleConfig.name
    });

    const prompt = await this.buildStagePrompt(stage, ctx);
    const { outputText: rawOutput, usage } = await this.invokeStage(stage, roleId, roleConfig, prompt, ctx);

    if (!rawOutput) {
      throw new Error(`Workflow stage '${stage.id}' returned empty output.`);
    }

    let outputText = await this.strategy.transformExecutedOutput({
      stageId: stage.id,
      ctx,
      output: rawOutput,
      hooks: this.options.hooks || []
    });

    outputText = await this.evaluateGate(stage, ctx, outputText, isGateActive, { span, usage });

    if (stage.transformOutput) {
      outputText = await stage.transformOutput(outputText, ctx);
    }

    outputText = await this.applyAfterStageHooks(stage, ctx, outputText);

    outputText = await this.strategy.transformSettledOutput({
      stageId: stage.id,
      ctx,
      output: outputText,
      hooks: this.options.hooks || []
    });

    if (!outputText) {
      throw new Error(`Workflow stage '${stage.id}' produced empty output after transformation.`);
    }

    for (const hook of this.options.hooks || []) {
      if (hook.onStageOutput) {
        await hook.onStageOutput({ stageId: stage.id, context: ctx, output: outputText });
      }
    }

    ctx.stageOutputs[stage.id] = outputText;
    ctx.stageLogs.push({
      stageId: stage.id,
      role: roleConfig.role,
      content: outputText,
      timestamp: Date.now()
    });

    this.strategy.applyStageOutputAliases(ctx, stage.id, outputText);

    if (this.options.ledgerExtractor) {
      const extracted = this.options.ledgerExtractor(outputText, ctx);
      ctx.stateLedger = mergeLedgers(ctx.stateLedger, extracted, this.strategy.includeLedgerAliases);
    }

    this.telemetry.endStage(span, usage);

    await this.events.emit({
      type: 'stage_end',
      stage: stage.id,
      stageId: stage.id,
      role: roleConfig.name,
      result: outputText
    });
  }

  /** 依次应用 stageHooks、通用 onBeforeStage 与策略专属的提示词改写。 */
  private async buildStagePrompt(stage: WorkflowStageConfig, ctx: WorkflowContext): Promise<string> {
    let prompt = stage.promptTemplate ? stage.promptTemplate(ctx) : ctx.userPrompt;

    if (this.options.stageHooks?.onBeforeStage) {
      const transformedPrompt = await this.options.stageHooks.onBeforeStage(stage.id, ctx, prompt);
      if (transformedPrompt) prompt = transformedPrompt;
    }

    for (const hook of this.options.hooks || []) {
      if (hook.onBeforeStage) {
        const transformedPrompt = await hook.onBeforeStage({
          stageId: stage.id,
          context: ctx,
          prompt
        });
        if (transformedPrompt) prompt = transformedPrompt;
      }
    }

    return this.strategy.transformStagePrompt({
      stageId: stage.id,
      ctx,
      prompt,
      hooks: this.options.hooks || []
    });
  }

  /**
   * 按优先级产出阶段文本：阶段自带 executor → 全局 customExecutor → 角色模型调用。
   */
  private async invokeStage(
    stage: WorkflowStageConfig,
    roleId: string,
    roleConfig: { role: string; name: string; systemPrompt: string },
    prompt: string,
    ctx: WorkflowContext
  ): Promise<{ outputText: string; usage?: Usage }> {
    if (stage.executor) {
      const res = await stage.executor(ctx, this.options.signal);
      let usage: Usage | undefined;
      if (typeof res === 'object') {
        usage = res.usage;
        if (res.modifiedLedger) {
          ctx.stateLedger = mergeLedgers(ctx.stateLedger, res.modifiedLedger, this.strategy.includeLedgerAliases);
        }
      }
      return { outputText: typeof res === 'string' ? res : res.text, usage };
    }

    if (this.options.customExecutor) {
      return {
        outputText: await this.options.customExecutor(roleId, roleConfig.systemPrompt, prompt, this.options.signal)
      };
    }

    const res = await this.invoker.invoke({
      config: roleConfig,
      prompt,
      ledger: ctx.stateLedger,
      model: this.options.model,
      signal: this.options.signal,
      ledgerFormatter: this.options.ledgerFormatter
    });
    return { outputText: res.text, usage: res.usage };
  }

  /**
   * 评估质量门禁。未命中规则或未配置处理器时原样返回产出。
   * 处理器拒绝时先以失败原因收尾遥测 span，再抛出。
   */
  private async evaluateGate(
    stage: WorkflowStageConfig,
    ctx: WorkflowContext,
    outputText: string,
    isGateActive: boolean,
    trace: StageTrace
  ): Promise<string> {
    const stageRules = this.gates.forStage(stage);
    if (!(stage.enableGate || isGateActive || stageRules.length > 0)) {
      return outputText;
    }

    const issues = detectGateIssues(outputText, stageRules, ctx.stateLedger, ctx);
    if (issues.length === 0) {
      return outputText;
    }

    this.strategy.applyGateIssues(ctx, issues);
    await this.events.emit(this.strategy.buildGateTriggeredEvent({ stageId: stage.id, output: outputText, issues }));

    const gateHandler = stage.gateHandler || this.options.qualityGateHandler || this.options.plotGateHandler;
    if (!gateHandler) {
      return outputText;
    }

    const gateEvent = {
      stageId: stage.id,
      content: outputText,
      issues,
      context: ctx
    } as Parameters<QualityGateHandler>[0];
    this.strategy.decorateGateHandlerEvent(gateEvent, ctx, outputText);
    const decision = await gateHandler(gateEvent);

    await this.events.emit(this.strategy.buildGateResolvedEvent({ stageId: stage.id, decision }));

    if (!decision.approved) {
      this.telemetry.failStage(trace.span, trace.usage, 'Quality Gate rejected');
      throw new Error(`门禁未通过: ${decision.feedback || '人工决策拒绝该阶段内容'}`);
    }

    if (decision.modifiedContent || decision.modifiedOutlineText) {
      return decision.modifiedContent || decision.modifiedOutlineText || outputText;
    }
    return outputText;
  }

  /** 依次应用 stageHooks 与通用 onAfterStage 的产出改写。 */
  private async applyAfterStageHooks(
    stage: WorkflowStageConfig,
    ctx: WorkflowContext,
    outputText: string
  ): Promise<string> {
    let result = outputText;

    if (this.options.stageHooks?.onAfterStage) {
      const transformedOutput = await this.options.stageHooks.onAfterStage(stage.id, result, ctx);
      if (transformedOutput) result = transformedOutput;
    }

    for (const hook of this.options.hooks || []) {
      if (hook.onAfterStage) {
        const transformedOutput = await hook.onAfterStage({
          stageId: stage.id,
          context: ctx,
          output: result
        });
        if (transformedOutput) result = transformedOutput;
      }
    }

    return result;
  }

  private throwIfAborted(signal: AbortSignal | undefined, stageId: string): void {
    if (signal?.aborted) {
      throw new Error(`Workflow aborted before stage '${stageId}'.`);
    }
  }
}
