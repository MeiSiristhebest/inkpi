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
} from '@inkpi/protocol';
import { formatChineseTypography } from '@inkpi/editor-core';
import { extractNovelStateLedger, formatNovelStateLedger } from '../compaction/state-ledger.js';
import { DEFAULT_ROLE_CONFIGS, RoleRegistry } from './roles.js';
import type { ModelConfig } from '@inkpi/ai';
import { getModelPreset, streamAi } from '@inkpi/ai';
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
  customExecutor?: (role: string, systemPrompt: string, userPrompt: string) => Promise<string>;
  telemetry?: TelemetryCollector;
  hooks?: PipelineHooks[];
  stageHooks?: WorkflowStageHooks;
  enablePlotGate?: boolean;
  enableQualityGate?: boolean;
  plotGateHandler?: PlotGateHandler;
  qualityGateHandler?: QualityGateHandler;
  customGateRules?: QualityGateRule[];
  stages?: WorkflowStageConfig[];
}


export type PipelineContext = WorkflowContext;
export type PipelineEvent = WorkflowEvent;
export type PipelineEventListener = WorkflowEventListener;

/**
 * 标准实体安全与破坏性变动门禁规则
 */
export function createStandardEntitySafetyRules(): QualityGateRule[] {
  return [
    {
      type: 'entity_elimination',
      severity: 'critical',
      description: '检测到关键实体被消灭/破坏，可能对后续链条造成不可逆破坏。',
      detector: (content, ledger) => {
        const allEntities = ledger.entities || ledger.characters || [];
        for (const char of allEntities) {
          const entityName = char.name;
          const deathRegex = new RegExp(`${entityName}[^。！？\n]*?(?:自爆|惨死|陨落|阵亡|身死道消|被杀|身亡|摧毁|销毁|死亡)`, 'g');
          if (deathRegex.test(content)) {
            return {
              type: 'entity_death',
              targetEntity: entityName,
              characterOrEntity: entityName,
              entityOrEntity: entityName,
              severity: 'critical',
              description: `检测到关键实体【${entityName}】在当前阶段被消灭/死亡，可能对后续链条造成不可逆破坏。`
            };

          }
        }
        return null;
      }
    },
    {
      type: 'major_twist',
      severity: 'warning',
      pattern: /(?:叛出|背叛|决裂|堕入|血洗|反目成仇|阵营反转)/,
      description: '检测到重大阵营决裂/颠覆性剧情变动，需确认是否符合设计意图。'
    }
  ];
}

/**
 * 影视剧本 (Screenplay) 专属门禁规则
 */
export function createScreenplayGateRules(): QualityGateRule[] {
  return [
    {
      type: 'scene_header_check',
      severity: 'warning',
      pattern: /^(?!(?:INT\.|EXT\.|内景|外景)).*$/m,
      description: '剧本场景未按标准场景标题 (INT./EXT. 或 内景/外景) 规范格式开头。'
    }
  ];
}

/**
 * 短剧分镜 (Short Drama) 专属门禁规则
 */
export function createShortDramaGateRules(): QualityGateRule[] {
  return [
    {
      type: 'hook_check',
      severity: 'warning',
      description: '短剧前 3 秒黄金吸睛钩子检测',
      detector: (content) => {
        const firstLines = content.slice(0, 100);
        if (!/(?:耳光|退婚|离婚|反击|惊呆|打脸|绝症|重生|神豪|首富|战神|震惊|质问)/.test(firstLines)) {
          return {
            type: 'weak_hook',
            severity: 'warning',
            description: '短剧前 3 秒黄金钩子较弱，建议增强开场冲突与吸睛情绪点。'
          };
        }
        return null;
      }
    }

  ];
}

/**
 * 视觉小说 (Visual Novel) 专属门禁规则
 */
export function createVisualNovelGateRules(): QualityGateRule[] {
  return [
    {
      type: 'choice_integrity',
      severity: 'warning',
      pattern: /<choice[^>]*>.*?<\/choice>/,
      description: '视觉小说分支选项节点已就绪。'
    }
  ];
}

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
    this.roleRegistry = new RoleRegistry({ initialRoles: DEFAULT_ROLE_CONFIGS });

    if (options.stages && options.stages.length > 0) {
      this.stages = [...options.stages];
    } else {
      this.initDefaultStages();
    }

    this.gateRules = [
      ...createStandardEntitySafetyRules(),
      ...(options.customGateRules || [])
    ];

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
      modifiedResources: [],
      characters: [],
      items: [],
      foreshadowings: [],
      modifiedChapters: []
    };
    const issues: (QualityGateIssue & { entityOrEntity?: string })[] = [];

    for (const rule of this.gateRules) {
      if (rule.pattern) {
        const regex = typeof rule.pattern === 'string' ? new RegExp(rule.pattern, 'g') : rule.pattern;
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
    const ctx: WorkflowContext = {
      title: initialCtx.title || initialCtx.bookTitle || '',
      bookTitle: initialCtx.bookTitle || initialCtx.title || '',
      sectionTitle: initialCtx.sectionTitle || initialCtx.chapterTitle || '',
      chapterTitle: initialCtx.chapterTitle || initialCtx.sectionTitle || '',
      userPrompt: initialCtx.userPrompt || '',
      stageOutputs: { ...(initialCtx.stageOutputs || {}) },
      stageLogs: [],
      ...initialCtx,
      stateLedger: initialCtx.stateLedger || {
        entities: [],
        assets: [],
        tracks: [],
        locations: [],
        modifiedResources: [],
        characters: [],
        items: [],
        foreshadowings: [],
        modifiedChapters: []
      }
    };

    const isGateActive = Boolean(this.options.enablePlotGate || this.options.enableQualityGate);

    for (const stage of this.stages) {
      const roleId = typeof stage.role === 'string' ? stage.role : (stage.role?.role || stage.id);
      const roleConfig = typeof stage.role === 'object' ? stage.role : this.roleRegistry.get(roleId) || {
        role: roleId,
        name: stage.name,
        systemPrompt: stage.systemPrompt || `你是一个专业的 ${stage.name} Agent。`
      };

      const stageSpan = this.telemetry?.startSpan(stage.name, stage.id, roleConfig.role);
      await this.emit({ type: 'stage_start', stage: stage.id, stageId: stage.id, role: roleConfig.name });

      // 生成提示词
      let prompt = stage.promptTemplate ? stage.promptTemplate(ctx) : ctx.userPrompt;
      if (this.options.stageHooks?.onBeforeStage) {
        const transformedPrompt = await this.options.stageHooks.onBeforeStage(stage.id, ctx, prompt);
        if (transformedPrompt) prompt = transformedPrompt;
      }
      if (stage.id === 'outline' && this.options.hooks) {
        for (const hook of this.options.hooks) {
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
        const res = await stage.executor(ctx);
        outputText = typeof res === 'string' ? res : res.text;
        if (typeof res === 'object') {
          stageUsage = res.usage;
          if (res.modifiedLedger) {
            ctx.stateLedger = this.mergeLedgers(ctx.stateLedger, res.modifiedLedger as StateLedger, ctx.chapterTitle || ctx.sectionTitle || '');
          }
        }
      } else if (this.options.customExecutor) {
        outputText = await this.options.customExecutor(roleId, roleConfig.systemPrompt, prompt);
      } else {
        const runRes = await this.runAgentRole(roleConfig, prompt, ctx.stateLedger);
        outputText = runRes.text;
        stageUsage = runRes.usage;
      }

      if (stage.id === 'draft' && this.options.hooks) {
        for (const hook of this.options.hooks) {
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

      if (stage.id === 'audit' && this.options.hooks) {
        for (const hook of this.options.hooks) {
          if (hook.onAuditPass) {
            await hook.onAuditPass({
              auditNotes: [outputText],
              passed: true
            });
          }
        }
      }

      // 门禁检查 (Quality Gate)
      if (stage.enableGate || isGateActive) {
        const issues = this.detectPlotGateIssues(outputText, ctx.stateLedger, ctx);
        if (issues.length > 0) {
          ctx.qualityIssues = issues;
          ctx.plotGateIssues = issues;
          (ctx as any).qualityGateIssues = issues;
          await this.emit({
            type: 'plot_gate_triggered',
            issues,
            outlineText: outputText,
            stageId: stage.id
          });

          const gateHandler = stage.gateHandler || this.options.qualityGateHandler || this.options.plotGateHandler;
          if (gateHandler) {
            const decision = await gateHandler({
              stageId: stage.id,
              content: outputText,
              issues,
              context: ctx,
              bookTitle: ctx.bookTitle,
              chapterTitle: ctx.chapterTitle,
              outlineText: outputText
            });

            await this.emit({
              type: 'plot_gate_resolved',
              approved: decision.approved,
              modifiedOutlineText: decision.modifiedContent || decision.modifiedOutlineText,
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

      if (this.options.stageHooks?.onAfterStage) {
        const transformedOutput = await this.options.stageHooks.onAfterStage(stage.id, outputText, ctx);
        if (transformedOutput) outputText = transformedOutput;
      }

      if (stage.id === 'polish' && this.options.hooks) {

        for (const hook of this.options.hooks) {
          if (hook.onPolishDone) {
            const res = await hook.onPolishDone({
              polishedText: outputText
            });
            if (res) outputText = res;
          }
        }
      }

      ctx.stageOutputs[stage.id] = outputText;
      ctx.stageLogs.push({
        stageId: stage.id,
        role: roleConfig.role,
        content: outputText,
        timestamp: Date.now()
      });

      // 映射向后兼容字段
      if (stage.id === 'outline') ctx.outlineText = outputText;
      if (stage.id === 'draft') ctx.draftText = outputText;
      if (stage.id === 'audit') ctx.auditNotes = [outputText];
      if (stage.id === 'polish') ctx.polishedText = outputText;

      // 从生成内容中增量提取实体状态账本
      const stageMessages = [{ role: 'assistant', content: [{ type: 'text', text: outputText }] } as any];
      const newLedger = extractNovelStateLedger(stageMessages);
      ctx.stateLedger = this.mergeLedgers(ctx.stateLedger, newLedger, ctx.chapterTitle || ctx.sectionTitle || '');

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
    return this.runWorkflow({
      bookTitle,
      title: bookTitle,
      chapterTitle,
      sectionTitle: chapterTitle,
      userPrompt,
      stateLedger: initialLedger
    });
  }

  private initDefaultStages(): void {
    // 阶段 1: 结构与大纲规划 (Planning & Structure Stage)
    this.registerStage({
      id: 'outline',
      name: '结构大纲规划',
      role: 'architect',
      enableGate: true,
      promptTemplate: (ctx) => {
        const ledgerSummary = formatNovelStateLedger(ctx.stateLedger);
        const title = ctx.title || ctx.bookTitle || '创作任务';
        const section = ctx.sectionTitle || ctx.chapterTitle || '主干内容';
        return `【创作主题】: ${title} - ${section}\n【指令与要求】: ${ctx.userPrompt}\n【当前状态账本】:\n${ledgerSummary}\n\n请输出结构化大纲与核心节点规划。`;
      }
    });

    // 阶段 2: 正文起草与生成 (Draft & Generation Stage)
    this.registerStage({
      id: 'draft',
      name: '正文主创展开',
      role: 'writer',
      promptTemplate: (ctx) => {
        const outline = ctx.stageOutputs['outline'] || ctx.outlineText || ctx.userPrompt;
        const ledgerSummary = formatNovelStateLedger(ctx.stateLedger);
        return `【大纲与依据】:\n${outline}\n\n【状态账本】:\n${ledgerSummary}\n\n请根据大纲展开高质量内容创作。`;
      }
    });

    // 阶段 3: 一致性与约束审计 (Audit & Verification Stage)
    this.registerStage({
      id: 'audit',
      name: '约束与一致性审计',
      role: 'auditor',
      promptTemplate: (ctx) => {
        const draft = ctx.stageOutputs['draft'] || ctx.draftText || '';
        const ledgerSummary = formatNovelStateLedger(ctx.stateLedger);
        return `【待审内容】:\n${draft}\n\n【状态账本】:\n${ledgerSummary}\n\n请核查生成内容是否符合设定与规则约束，并输出审计结论。`;
      }
    });

    // 阶段 4: 排版校对与润色 (Polish & Format Stage)
    this.registerStage({
      id: 'polish',
      name: '排版校对与润色',
      role: 'polisher',
      promptTemplate: (ctx) => {
        const draft = ctx.stageOutputs['draft'] || ctx.draftText || '';
        const audit = ctx.stageOutputs['audit'] || '';
        return `【原稿内容】:\n${draft}\n\n【审计反馈】:\n${audit}\n\n请进行规范排版与文字润色。`;
      },
      transformOutput: (output) => {
        return formatChineseTypography(output);
      }
    });
  }

  private async runAgentRole(
    config: AgentRoleConfig,
    prompt: string,
    ledger?: StateLedger
  ): Promise<{ text: string; usage: Usage }> {
    const model = this.options.model || getModelPreset('creative-pro');
    const ledgerBlock = formatNovelStateLedger(ledger);
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
        thinkingBudget: config.defaultThinkingLevel === 'high' ? 4000 : 2000
      }
    );

    const assistantMsg = await stream.collect();
    const texts = assistantMsg.content
      .filter((c) => c.type === 'text')
      .map((c) => (c as any).text)
      .join('\n');

    return {
      text: texts || `【${config.name}完成】`,
      usage: assistantMsg.usage || { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    };
  }

  private mergeLedgers(base: StateLedger, addition: StateLedger, sectionName: string): StateLedger {
    const baseEntities = base.entities || base.characters || [];
    const addEntities = addition.entities || addition.characters || [];
    const charMap = new Map<string, any>(
      baseEntities.map((c: any) => [c.id || c.name, c])
    );
    for (const c of addEntities) {
      const existing = charMap.get(c.id || c.name);
      charMap.set(c.id || c.name, existing ? { ...existing, ...c } : { ...c });
    }

    const baseAssets = base.assets || base.items || [];
    const addAssets = addition.assets || addition.items || [];
    const itemMap = new Map<string, any>(
      baseAssets.map((i: any) => [i.id || i.name, i])
    );
    for (const item of addAssets) {
      const existing = itemMap.get(item.id || item.name);
      itemMap.set(item.id || item.name, existing ? { ...existing, ...item } : { ...item });
    }

    const chapters = new Set([
      ...(base.modifiedChapters || base.modifiedResources || []),
      ...(addition.modifiedChapters || addition.modifiedResources || []),
      sectionName
    ]);

    const characters = Array.from(charMap.values());
    const items = Array.from(itemMap.values());
    const foreshadowings = [...(base.foreshadowings || base.tracks || []), ...(addition.foreshadowings || addition.tracks || [])];
    const locations = [...(base.locations || []), ...(addition.locations || [])];
    const modifiedChapters = Array.from(chapters);

    return {
      characters,
      items,
      foreshadowings,
      locations,
      modifiedChapters,
      entities: characters,
      assets: items,
      tracks: foreshadowings,
      modifiedResources: modifiedChapters,
      modifiedDocuments: modifiedChapters
    } as any;
  }
}

/** 别名兼容 */
export const NovelCollaborativePipeline = WorkflowCoordinator;
export type NovelCollaborativePipeline = WorkflowCoordinator;

export const CollaborativePipeline = WorkflowCoordinator;
export type CollaborativePipeline = WorkflowCoordinator;

export const PipelineCoordinator = WorkflowCoordinator;
export type PipelineCoordinator = WorkflowCoordinator;
