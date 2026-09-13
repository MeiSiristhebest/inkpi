import type {
  PipelineHooks,
  QualityGateDecision,
  QualityGateHandler,
  QualityGateIssue,
  WorkflowContext,
  WorkflowEvent
} from '@inkpi/protocol';

/** Workflow execution is intentionally domain-neutral. */
export type WorkflowMode = 'generic';

export type GateTriggeredEvent = Extract<WorkflowEvent, { type: 'quality_gate_triggered' }>;
export type GateResolvedEvent = Extract<WorkflowEvent, { type: 'quality_gate_resolved' }>;

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
 * Domain-neutral workflow customization points.
 *
 * Domain-specific behavior belongs in an explicit TaskHandler or a caller
 * supplied stage configuration. The coordinator itself only implements this
 * generic strategy.
 */
export interface WorkflowStrategy {
  readonly mode: WorkflowMode;
  readonly includeLedgerAliases: boolean;
  transformStagePrompt(args: {
    stageId: string;
    ctx: WorkflowContext;
    prompt: string;
    hooks: PipelineHooks[];
  }): Promise<string>;
  transformExecutedOutput(args: ExecutedOutputArgs): Promise<string>;
  transformSettledOutput(args: SettledOutputArgs): Promise<string>;
  applyGateIssues(ctx: WorkflowContext, issues: QualityGateIssue[]): void;
  buildGateTriggeredEvent(args: GateTriggeredArgs): GateTriggeredEvent;
  buildGateResolvedEvent(args: GateResolvedArgs): GateResolvedEvent;
  decorateGateHandlerEvent(event: GateHandlerEvent, ctx: WorkflowContext, output: string): void;
  applyStageOutputAliases(ctx: WorkflowContext, stageId: string, output: string): void;
}

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
    // Generic mode does not add domain-specific aliases.
  },

  applyStageOutputAliases() {
    // Generic mode stores outputs only under ctx.stageOutputs.
  }
};
