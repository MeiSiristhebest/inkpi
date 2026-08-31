import type {
  StateLedger,
  NovelStateLedger,
  PipelineHooks,
  Usage,
  QualityGateIssue,
  QualityGateDecision,
  QualityGateRule,
  QualityGateHandler,
  WorkflowStageConfig,
  WorkflowContext,
  WorkflowEvent,
  WorkflowEventListener,
  AgentRoleConfig
} from '@meisiristhebest/protocol';
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

import type { ModelConfig } from '@meisiristhebest/ai';
import { getModelPreset, streamAi } from '@meisiristhebest/ai';
import { TelemetryCollector } from '../telemetry/telemetry.js';

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
  /** 仅供旧 pipeline.run 兼容字段和事件名称；通用工作流不启用。 */
  compatibilityMode?: 'legacy-pipeline';
}



export type PipelineContext = WorkflowContext;
export type PipelineEvent = WorkflowEvent;
export type PipelineEventListener = WorkflowEventListener;

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
 * 纯通用多 Agent 创作工作流编排引擎 (1:1 对标 repos/pi handoff & multi-agent workflow 范式)
 * 具备 0 业务偏见，支持任意动态注册的流水线阶段 (Stages)、动态角色 (Roles)、
 * 动态人机交互门禁 (Quality Gate Rules) 与上下文流转。
 */
export class WorkflowCoordinator {
  public telemetry?: TelemetryCollector;
  private listeners: WorkflowEventListener[] = [];
  private options: PipelineExecutionOptions;
  private roleRegistry: RoleRegistry;
  private stages: WorkflowStageConfig[] = [];
  private gateRules: QualityGateRule[] = [];

  constructor(options: PipelineExecutionOptions = {}) {
    this.options = options;
    this.telemetry = options.telemetry;
    this.roleRegistry = options.roleRegistry ?? new RoleRegistry(
      options.initialRoles ? { initialRoles: options.initialRoles } : {}
    );


    this.stages = [...(options.stages || [])];
    this.gateRules = [...(options.customGateRules || [])];

  }

  /**
   * 动态注册或覆盖流水线阶段
   */
  public registerStage(config: WorkflowStageConfig): this {
    const existingIdx = this.stages.findIndex((s) => s.id === config.id);
    if (existingIdx !== -1) {
      this.stages[existingIdx] = config;
    } else {
      this.stages.push(config);
    }
    return this;
  }

  /**
   * 动态添加质量门禁规则
   */
  public addGateRule(rule: QualityGateRule): this {
    this.gateRules.push(rule);
    return this;
  }

  /**
   * 订阅工作流事件流
   */
  public subscribe(listener: WorkflowEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  private async emit(event: WorkflowEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener(event);
      } catch (err) {
        console.error('[WorkflowCoordinator] Error in event listener:', err);
      }
    }
  }

  /**
   * 纯规则驱动的质量门禁自动检测 (100% 领域中立)
   */
  public detectPlotGateIssues(
    content: string,
    ledger?: StateLedger,
    context?: any
  ): (QualityGateIssue & { entityOrEntity?: string })[] {
    const safeLedger: StateLedger = ledger || {
      entities: [],
      assets: [],
      tracks: [],
      locations: [],
      modifiedResources: []
    };
    const issues: (QualityGateIssue & { entityOrEntity?: string })[] = [];

    for (const rule of this.gateRules) {
      if (rule.pattern) {
        const regex = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'g') : rule.pattern;
        regex.lastIndex = 0;
        if (regex.test(content)) {
          issues.push({
            type: rule.type,
            description: rule.description,
            severity: rule.severity
          });
        }
      }
      if (rule.detector) {
        const issue = rule.detector(content, safeLedger, context);
        if (issue) issues.push(issue);
      }
    }

    return issues;
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
    return this.executeWorkflow(initialCtx, this.stages, this.options);
  }

  private async executeWorkflow(
    initialCtx: Partial<WorkflowContext>,
    stages: WorkflowStageConfig[],
    options: PipelineExecutionOptions
  ): Promise<WorkflowContext> {
    const ctx: WorkflowContext = {
      ...initialCtx,
      userPrompt: initialCtx.userPrompt ?? '',
      stateLedger: initialCtx.stateLedger ?? this.emptyLedger(),
      stageOutputs: { ...(initialCtx.stageOutputs || {}) },
      stageLogs: [...(initialCtx.stageLogs || [])]
    };

    const isGateActive = Boolean(options.enablePlotGate || options.enableQualityGate);

    for (const stage of stages) {
      this.throwIfAborted(options.signal, stage.id);
      const roleId = typeof stage.role === 'string' ? stage.role : (stage.role?.role || stage.id);
      const roleConfig = typeof stage.role === 'object' ? stage.role : this.roleRegistry.get(roleId) || {
        role: roleId,
        name: stage.name,
        systemPrompt: stage.systemPrompt || ''
      };

      const stageSpan = this.telemetry?.startSpan(stage.name, stage.id, roleConfig.role);
      await this.emit({ type: 'stage_start', stage: stage.id, stageId: stage.id, role: roleConfig.name });

      // 生成提示词
      let prompt = stage.promptTemplate ? stage.promptTemplate(ctx) : ctx.userPrompt;
      if (options.stageHooks?.onBeforeStage) {
        const transformedPrompt = await options.stageHooks.onBeforeStage(stage.id, ctx, prompt);
        if (transformedPrompt) prompt = transformedPrompt;
      }
      for (const hook of options.hooks || []) {
        if (hook.onBeforeStage) {
          const transformedPrompt = await hook.onBeforeStage({
            stageId: stage.id,
            context: ctx,
            prompt
          });
          if (transformedPrompt) prompt = transformedPrompt;
        }
      }
      if (options.compatibilityMode === 'legacy-pipeline' && stage.id === 'outline' && options.hooks) {
        for (const hook of options.hooks) {
          if (hook.onBeforeOutline) {
            const res = await hook.onBeforeOutline({
              bookTitle: ctx.bookTitle,
              chapterTitle: ctx.chapterTitle,
              documentTitle: ctx.title,
              sectionTitle: ctx.sectionTitle,
              userPrompt: prompt
            });
            if (res) prompt = res;
          }
        }
      }


      let outputText = '';
      let stageUsage: Usage | undefined;

      if (stage.executor) {
        const res = await stage.executor(ctx, options.signal);
        outputText = typeof res === 'string' ? res : res.text;
        if (typeof res === 'object') {
          stageUsage = res.usage;
          if (res.modifiedLedger) {
            ctx.stateLedger = this.mergeLedgers(
              ctx.stateLedger,
              res.modifiedLedger,
              options.compatibilityMode === 'legacy-pipeline'
            );
          }
        }
      } else if (options.customExecutor) {
        outputText = await options.customExecutor(roleId, roleConfig.systemPrompt, prompt, options.signal);
      } else {
        const runRes = await this.runAgentRole(roleConfig, prompt, ctx.stateLedger, options);
        outputText = runRes.text;
        stageUsage = runRes.usage;
      }

      if (!outputText) {
        throw new Error(`Workflow stage '${stage.id}' returned empty output.`);
      }

      if (options.compatibilityMode === 'legacy-pipeline' && stage.id === 'draft' && options.hooks) {
        for (const hook of options.hooks) {
          if (hook.onDraftGenerated) {
            const res = await hook.onDraftGenerated({
              bookTitle: ctx.bookTitle,
              chapterTitle: ctx.chapterTitle,
              documentTitle: ctx.title,
              sectionTitle: ctx.sectionTitle,
              draftText: outputText
            });
            if (res) outputText = res;
          }
        }
      }

      if (options.compatibilityMode === 'legacy-pipeline' && stage.id === 'audit' && options.hooks) {
        for (const hook of options.hooks) {
          if (hook.onAuditPass) {
            await hook.onAuditPass({
              auditNotes: [outputText],
              passed: true
            });
          }
        }
      }

      // 门禁检查 (Quality Gate)
      const stageRules = [...this.gateRules, ...(stage.gateRules || [])];
      if (stage.enableGate || isGateActive || stageRules.length > 0) {
        const issues = this.detectIssues(outputText, ctx.stateLedger, ctx, stageRules);
        if (issues.length > 0) {
          ctx.qualityIssues = issues;
          ctx.qualityGateIssues = issues;
          if (options.compatibilityMode === 'legacy-pipeline') {
            ctx.plotGateIssues = issues;
          }
          await this.emit({
            type: options.compatibilityMode === 'legacy-pipeline' ? 'plot_gate_triggered' : 'quality_gate_triggered',
            issues,
            content: outputText,
            ...(options.compatibilityMode === 'legacy-pipeline' ? { outlineText: outputText } : {}),
            stageId: stage.id
          });

          const gateHandler = stage.gateHandler || options.qualityGateHandler || options.plotGateHandler;
          if (gateHandler) {
            const gateEvent = {
              stageId: stage.id,
              content: outputText,
              issues,
              context: ctx
            } as Parameters<QualityGateHandler>[0];
            if (options.compatibilityMode === 'legacy-pipeline') {
              gateEvent.workspaceTitle = ctx.workspaceTitle;
              gateEvent.documentTitle = ctx.documentTitle;
              gateEvent.bookTitle = ctx.bookTitle;
              gateEvent.chapterTitle = ctx.chapterTitle;
              gateEvent.outlineText = outputText;
            }
            const decision = await gateHandler(gateEvent);

            await this.emit({
              type: options.compatibilityMode === 'legacy-pipeline' ? 'plot_gate_resolved' : 'quality_gate_resolved',
              approved: decision.approved,
              ...(options.compatibilityMode === 'legacy-pipeline'
                ? { modifiedOutlineText: decision.modifiedContent || decision.modifiedOutlineText }
                : { modifiedContent: decision.modifiedContent }),
              feedback: decision.feedback,
              stageId: stage.id
            });

            if (!decision.approved) {
              if (stageSpan) {
                this.telemetry?.endSpan(stageSpan.id, stageUsage, 'Quality Gate rejected');
              }
              throw new Error(`门禁未通过: ${decision.feedback || '人工决策拒绝该阶段内容'}`);
            }
            if (decision.modifiedContent || decision.modifiedOutlineText) {
              outputText = decision.modifiedContent || decision.modifiedOutlineText || outputText;
            }
          }
        }
      }

      if (stage.transformOutput) {
        outputText = await stage.transformOutput(outputText, ctx);
      }

      if (options.stageHooks?.onAfterStage) {
        const transformedOutput = await options.stageHooks.onAfterStage(stage.id, outputText, ctx);
        if (transformedOutput) outputText = transformedOutput;
      }

      for (const hook of options.hooks || []) {
        if (hook.onAfterStage) {
          const transformedOutput = await hook.onAfterStage({
            stageId: stage.id,
            context: ctx,
            output: outputText
          });
          if (transformedOutput) outputText = transformedOutput;
        }
      }

      if (options.compatibilityMode === 'legacy-pipeline' && stage.id === 'polish' && options.hooks) {

        for (const hook of options.hooks) {
          if (hook.onPolishDone) {
            const res = await hook.onPolishDone({
              polishedText: outputText
            });
            if (res) outputText = res;
          }
        }
      }

      if (!outputText) {
        throw new Error(`Workflow stage '${stage.id}' produced empty output after transformation.`);
      }

      for (const hook of options.hooks || []) {
        if (hook.onStageOutput) {
          await hook.onStageOutput({
            stageId: stage.id,
            context: ctx,
            output: outputText
          });
        }
      }

      ctx.stageOutputs[stage.id] = outputText;
      ctx.stageLogs.push({
        stageId: stage.id,
        role: roleConfig.role,
        content: outputText,
        timestamp: Date.now()
      });

      if (options.compatibilityMode === 'legacy-pipeline') {
        if (stage.id === 'outline') ctx.outlineText = outputText;
        if (stage.id === 'draft') ctx.draftText = outputText;
        if (stage.id === 'audit') ctx.auditNotes = [outputText];
        if (stage.id === 'polish') ctx.polishedText = outputText;
      }

      if (options.ledgerExtractor) {
        const extracted = options.ledgerExtractor(outputText, ctx);
        ctx.stateLedger = this.mergeLedgers(
          ctx.stateLedger,
          extracted,
          options.compatibilityMode === 'legacy-pipeline'
        );
      }

      if (stageSpan) {
        this.telemetry?.endSpan(stageSpan.id, stageUsage);
      }

      await this.emit({
        type: 'stage_end',
        stage: stage.id,
        stageId: stage.id,
        role: roleConfig.name,
        result: outputText
      });
    }

    await this.emit({ type: 'pipeline_complete', result: ctx });
    return ctx;
  }

  /**
   * 向后兼容快捷调用方法
   */
  public async runPipeline(
    bookTitle: string,
    chapterTitle: string,
    userPrompt: string,
    initialLedger?: StateLedger
  ): Promise<PipelineContext> {
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
    const legacyCoordinator = new WorkflowCoordinator(legacyOptions);
    legacyCoordinator.subscribe((event) => this.emit(event));
    const legacyStages = createLegacyNarrativeStages();
    for (const stage of this.stages) {
      const index = legacyStages.findIndex((candidate) => candidate.id === stage.id);
      if (index >= 0) legacyStages[index] = stage;
      else legacyStages.push(stage);
    }
    return legacyCoordinator.executeWorkflow({
      bookTitle,
      title: bookTitle,
      chapterTitle,
      sectionTitle: chapterTitle,
      userPrompt,
      stateLedger: initialLedger
    }, legacyStages, legacyOptions);
  }

  private async runAgentRole(
    config: AgentRoleConfig,
    prompt: string,
    ledger: StateLedger | undefined,
    options: PipelineExecutionOptions
  ): Promise<{ text: string; usage?: Usage }> {
    if (!options.model) {
      throw new Error('Workflow requires an explicit model or executor.');
    }
    const model = options.model;
    const ledgerBlock = options.ledgerFormatter?.(ledger || this.emptyLedger()) || '';
    const systemPromptWithLedger = ledgerBlock
      ? `${config.systemPrompt}\n\n【核心状态账本快照】\n${ledgerBlock}`
      : config.systemPrompt;

    const stream = streamAi(
      model,
      [
        { role: 'user', content: prompt, timestamp: Date.now() }
      ],
      {
        systemPrompt: systemPromptWithLedger,
        thinkingBudget: config.defaultThinkingLevel === 'high' ? 4000 : 2000,
        signal: options.signal
      }
    );

    const assistantMsg = await stream.collect();
    if (assistantMsg.stopReason === 'error') {
      throw new Error(assistantMsg.errorMessage || `Model failed during workflow stage '${config.role}'.`);
    }
    const texts = assistantMsg.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as any).text)
      .join('\n');

    if (!texts) {
      throw new Error(`Model returned empty output for workflow role '${config.role}'.`);
    }
    return { text: texts, usage: assistantMsg.usage };
  }

  private detectIssues(content: string, ledger: StateLedger, context: any, rules: QualityGateRule[]): QualityGateIssue[] {
    const issues: QualityGateIssue[] = [];
    for (const rule of rules) {
      if (rule.pattern) {
        const regex = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'g') : rule.pattern;
        regex.lastIndex = 0;
        if (regex.test(content)) issues.push({ type: rule.type, description: rule.description, severity: rule.severity });
      }
      if (rule.detector) {
        const issue = rule.detector(content, ledger, context);
        if (issue) issues.push(issue);
      }
    }
    return issues;
  }

  private emptyLedger(): StateLedger {
    return { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] } as StateLedger;
  }

  private throwIfAborted(signal: AbortSignal | undefined, stageId: string): void {
    if (signal?.aborted) {
      throw new Error(`Workflow aborted before stage '${stageId}'.`);
    }
  }

  private mergeLedgers(
    base: StateLedger,
    addition: Partial<StateLedger>,
    includeLegacyAliases = false
  ): StateLedger {
    const baseEntities = base.entities || base.characters || [];
    const addEntities = addition.entities || addition.characters || [];
    const charMap = new Map<string, any>(
      baseEntities.map((c: any, index) => [c.id || c.name || `entity-${index}`, c])
    );
    for (const c of addEntities) {
      const key = c.id || c.name || `entity-${charMap.size}`;
      const existing = charMap.get(key);
      charMap.set(key, existing ? { ...existing, ...c } : { ...c });
    }

    const baseAssets = base.assets || base.items || [];
    const addAssets = addition.assets || addition.items || [];
    const itemMap = new Map<string, any>(
      baseAssets.map((i: any, index) => [i.id || i.name || `asset-${index}`, i])
    );
    for (const item of addAssets) {
      const key = item.id || item.name || `asset-${itemMap.size}`;
      const existing = itemMap.get(key);
      itemMap.set(key, existing ? { ...existing, ...item } : { ...item });
    }

    const chapters = new Set([
      ...(base.modifiedResources || base.modifiedChapters || base.modifiedDocuments || []),
      ...(addition.modifiedResources || addition.modifiedChapters || addition.modifiedDocuments || []),
    ]);

    const characters = Array.from(charMap.values());
    const items = Array.from(itemMap.values());
    const tracks = mergeRecords(base.tracks || [], addition.tracks || [], (track: any, index) =>
      track.id || track.clue || track.summary || `track-${index}`
    );
    const locations = mergeRecords(base.locations || [], addition.locations || [], (location: any, index) =>
      location.id || location.name || `location-${index}`
    );

    const result: StateLedger = {
      ...base,
      ...addition,
      locations,
      entities: characters,
      assets: items,
      tracks,
      modifiedResources: Array.from(chapters)
    } as StateLedger;

    if (!includeLegacyAliases) {
      delete (result as any).characters;
      delete (result as any).items;
      delete (result as any).foreshadowings;
      delete (result as any).modifiedChapters;
      delete (result as any).modifiedDocuments;
      return result;
    }

    Object.assign(result, {
      characters,
      items,
      foreshadowings: tracks,
      modifiedChapters: Array.from(chapters),
      modifiedDocuments: Array.from(chapters)
    });
    return result;
  }
}

function mergeRecords<T extends Record<string, unknown>>(
  base: T[],
  addition: T[],
  keyOf: (record: T, index: number) => string
): T[] {
  const records = new Map<string, T>();
  for (const [index, record] of [...base, ...addition].entries()) {
    const key = keyOf(record, index);
    const previous = records.get(key);
    records.set(key, previous ? { ...previous, ...record } : { ...record });
  }
  return Array.from(records.values());
}

/** 别名兼容 */
export const NovelCollaborativePipeline = WorkflowCoordinator;
export type NovelCollaborativePipeline = WorkflowCoordinator;

export const CollaborativePipeline = WorkflowCoordinator;
export type CollaborativePipeline = WorkflowCoordinator;

export const PipelineCoordinator = WorkflowCoordinator;
export type PipelineCoordinator = WorkflowCoordinator;
