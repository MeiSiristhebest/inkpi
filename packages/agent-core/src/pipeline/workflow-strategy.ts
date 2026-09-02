import type {
  PipelineHooks,
  QualityGateDecision,
  QualityGateIssue,
  WorkflowContext,
  WorkflowEvent,
  QualityGateHandler
} from '@inkpi/protocol';

/**
 * 工作流执行模式。
 *
 * `generic` 是中性模式：只使用通用生命周期钩子与中性事件名。
 * `legacy-pipeline` 是兼容模式：额外调用按阶段名特化的旧钩子，
 * 并向事件/上下文写入旧字段别名（`outlineText` / `plot_gate_*` 等）。
 */
export type WorkflowMode = 'generic' | 'legacy-pipeline';

export type GateTriggeredEvent = Extract<
  WorkflowEvent,
  { type: 'quality_gate_triggered' | 'plot_gate_triggered' }
>;
export type GateResolvedEvent = Extract<
  WorkflowEvent,
  { type: 'quality_gate_resolved' | 'plot_gate_resolved' }
>;

export type GateHandlerEvent = Parameters<QualityGateHandler>[0];

export interface ExecutedOutputArgs {
  stageId: string;
  ctx: WorkflowContext;
  output: string;
  hooks: PipelineHooks[];
}

export interface SettledOutputArgs {
  stageId: string;
  ctx: WorkflowContext;
  output: string;
  hooks: PipelineHooks[];
}

export interface GateTriggeredArgs {
  stageId: string;
  output: string;
  issues: QualityGateIssue[];
}

export interface GateResolvedArgs {
  stageId: string;
  decision: QualityGateDecision;
}

/**
 * 工作流差异策略。
 *
 * `WorkflowCoordinator` 原本在 10 处直接判断
 * `compatibilityMode === 'legacy-pipeline'`。这些差异全部收敛到本接口后面：
 * 执行器只调用策略方法，不再知道"兼容模式"的存在。新增一种执行模式
 * 只需实现本接口，无需改动协调器。
 */
export interface WorkflowStrategy {
  readonly mode: WorkflowMode;

  /** 账本合并时是否保留旧字段别名（`characters` / `chapters` 等）。 */
  readonly includeLedgerAliases: boolean;

  /** 阶段执行之前改写提示词。 */
  transformStagePrompt(args: { stageId: string; ctx: WorkflowContext; prompt: string; hooks: PipelineHooks[] }): Promise<string>;

  /** 阶段产出之后、门禁检查之前改写产出。 */
  transformExecutedOutput(args: ExecutedOutputArgs): Promise<string>;

  /** 门禁与 `onAfterStage` 全部完成之后改写产出。 */
  transformSettledOutput(args: SettledOutputArgs): Promise<string>;

  /** 门禁命中后把 issue 列表写入上下文的哪些字段。 */
  applyGateIssues(ctx: WorkflowContext, issues: QualityGateIssue[]): void;

  /** 构造"门禁命中"事件。 */
  buildGateTriggeredEvent(args: GateTriggeredArgs): GateTriggeredEvent;

  /** 构造"门禁裁决"事件。 */
  buildGateResolvedEvent(args: GateResolvedArgs): GateResolvedEvent;

  /** 为传给门禁处理器的事件补充模式专属字段。 */
  decorateGateHandlerEvent(event: GateHandlerEvent, ctx: WorkflowContext, output: string): void;

  /** 阶段产出写入上下文后，补写模式专属的兼容别名。 */
  applyStageOutputAliases(ctx: WorkflowContext, stageId: string, output: string): void;
}

type StagePromptHook = (
  ctx: WorkflowContext,
  prompt: string,
  hooks: PipelineHooks[]
) => Promise<string>;

type StageOutputHook = (
  ctx: WorkflowContext,
  output: string,
  hooks: PipelineHooks[]
) => Promise<string>;

/**
 * 兼容模式在阶段执行前调用的旧钩子，按阶段名索引。
 * 新增阶段无需修改控制流，只在此表登记。
 */
const LEGACY_STAGE_PROMPT_HOOKS: Record<string, StagePromptHook> = {
  outline: async (ctx, prompt, hooks) => {
    let result = prompt;
    for (const hook of hooks) {
      if (hook.onBeforeOutline) {
        const res = await hook.onBeforeOutline({
          bookTitle: ctx.bookTitle,
          chapterTitle: ctx.chapterTitle,
          documentTitle: ctx.title,
          sectionTitle: ctx.sectionTitle,
          userPrompt: result
        });
        if (res) result = res;
      }
    }
    return result;
  }
};

/**
 * 兼容模式在阶段产出后（门禁检查前）调用的旧钩子，按阶段名索引。
 * `audit` 只通知不改写产出，但仍返回原值以保持调用点统一。
 */
const LEGACY_EXECUTED_OUTPUT_HOOKS: Record<string, StageOutputHook> = {
  draft: async (ctx, output, hooks) => {
    let result = output;
    for (const hook of hooks) {
      if (hook.onDraftGenerated) {
        const res = await hook.onDraftGenerated({
          bookTitle: ctx.bookTitle,
          chapterTitle: ctx.chapterTitle,
          documentTitle: ctx.title,
          sectionTitle: ctx.sectionTitle,
          draftText: result
        });
        if (res) result = res;
      }
    }
    return result;
  },
  audit: async (_ctx, output, hooks) => {
    for (const hook of hooks) {
      if (hook.onAuditPass) {
        await hook.onAuditPass({ auditNotes: [output], passed: true });
      }
    }
    return output;
  }
};

/**
 * 兼容模式在 `onAfterStage` 全部完成后调用的旧钩子，按阶段名索引。
 */
const LEGACY_SETTLED_OUTPUT_HOOKS: Record<string, StageOutputHook> = {
  polish: async (_ctx, output, hooks) => {
    let result = output;
    for (const hook of hooks) {
      if (hook.onPolishDone) {
        const res = await hook.onPolishDone({ polishedText: result });
        if (res) result = res;
      }
    }
    return result;
  }
};

/**
 * 兼容模式把阶段产出额外写入的旧上下文字段，按阶段名索引。
 */
const LEGACY_OUTPUT_ALIASES: Record<string, (ctx: WorkflowContext, output: string) => void> = {
  outline: (ctx, output) => {
    ctx.outlineText = output;
  },
  draft: (ctx, output) => {
    ctx.draftText = output;
  },
  audit: (ctx, output) => {
    ctx.auditNotes = [output];
  },
  polish: (ctx, output) => {
    ctx.polishedText = output;
  }
};

/** 中性策略：只走通用生命周期钩子与中性事件名。 */
export const genericWorkflowStrategy: WorkflowStrategy = {
  mode: 'generic',
  includeLedgerAliases: false,

  async transformStagePrompt({ prompt }) {
    return prompt;
  },

  async transformExecutedOutput({ output }) {
    return output;
  },

  async transformSettledOutput({ output }) {
    return output;
  },

  applyGateIssues(ctx, issues) {
    ctx.qualityIssues = issues;
    ctx.qualityGateIssues = issues;
  },

  buildGateTriggeredEvent({ stageId, output, issues }) {
    return { type: 'quality_gate_triggered', issues, content: output, stageId };
  },

  buildGateResolvedEvent({ stageId, decision }) {
    return {
      type: 'quality_gate_resolved',
      approved: decision.approved,
      modifiedContent: decision.modifiedContent,
      feedback: decision.feedback,
      stageId
    };
  },

  decorateGateHandlerEvent() {
    // 中性模式不补充任何字段。
  },

  applyStageOutputAliases() {
    // 中性模式不写兼容别名。
  }
};

/** 兼容策略：额外调用旧钩子并写入旧字段别名。 */
export const legacyPipelineWorkflowStrategy: WorkflowStrategy = {
  mode: 'legacy-pipeline',
  includeLedgerAliases: true,

  async transformStagePrompt({ stageId, ctx, prompt, hooks }) {
    const hook = LEGACY_STAGE_PROMPT_HOOKS[stageId];
    return hook ? hook(ctx, prompt, hooks) : prompt;
  },

  async transformExecutedOutput({ stageId, ctx, output, hooks }) {
    const hook = LEGACY_EXECUTED_OUTPUT_HOOKS[stageId];
    return hook ? hook(ctx, output, hooks) : output;
  },

  async transformSettledOutput({ stageId, ctx, output, hooks }) {
    const hook = LEGACY_SETTLED_OUTPUT_HOOKS[stageId];
    return hook ? hook(ctx, output, hooks) : output;
  },

  applyGateIssues(ctx, issues) {
    ctx.qualityIssues = issues;
    ctx.qualityGateIssues = issues;
    ctx.plotGateIssues = issues;
  },

  buildGateTriggeredEvent({ stageId, output, issues }) {
    return {
      type: 'plot_gate_triggered',
      issues,
      content: output,
      outlineText: output,
      stageId
    };
  },

  buildGateResolvedEvent({ stageId, decision }) {
    return {
      type: 'plot_gate_resolved',
      approved: decision.approved,
      modifiedOutlineText: decision.modifiedContent || decision.modifiedOutlineText,
      feedback: decision.feedback,
      stageId
    };
  },

  decorateGateHandlerEvent(event, ctx, output) {
    event.workspaceTitle = ctx.workspaceTitle;
    event.documentTitle = ctx.documentTitle;
    event.bookTitle = ctx.bookTitle;
    event.chapterTitle = ctx.chapterTitle;
    event.outlineText = output;
  },

  applyStageOutputAliases(ctx, stageId, output) {
    LEGACY_OUTPUT_ALIASES[stageId]?.(ctx, output);
  }
};

/**
 * 按执行模式选择策略。未识别的模式一律回落到中性策略，
 * 以免未知选项静默启用兼容行为。
 */
export function resolveWorkflowStrategy(mode: string | undefined): WorkflowStrategy {
  return mode === 'legacy-pipeline' ? legacyPipelineWorkflowStrategy : genericWorkflowStrategy;
}
