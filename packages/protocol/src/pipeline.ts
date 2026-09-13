import type { Usage } from './messages.js';
import type { StateLedger } from './storage.js';

export type GateSeverity = 'info' | 'warning' | 'critical';

export interface QualityGateIssue {
  type: string;
  description: string;
  targetEntity?: string;
  characterOrEntity?: string;
  entityOrEntity?: string;
  severity: GateSeverity;
  metadata?: Record<string, unknown>;
}

export interface QualityGateDecision {
  approved: boolean;
  modifiedContent?: string;
  feedback?: string;
}

export interface QualityGateRule<TContext = any> {
  id?: string;
  type: string;
  pattern?: RegExp | string;
  detector?: (content: string, ledger: StateLedger, context?: TContext) => QualityGateIssue | null;
  severity: GateSeverity;
  description: string;
}

export type QualityGateHandler<TContext = any> = (event: {
  stageId: string;
  content: string;
  issues: QualityGateIssue[];
  context: TContext;
}) => Promise<QualityGateDecision> | QualityGateDecision;

export interface AgentRoleConfig {
  role: string;
  name: string;
  systemPrompt: string;
  description?: string;
  defaultThinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
}

export interface StageResult {
  text: string;
  usage?: Usage;
  metadata?: Record<string, unknown>;
  modifiedLedger?: Partial<StateLedger>;
}

export interface WorkflowStageConfig<TContext = any> {
  id: string;
  name: string;
  role?: AgentRoleConfig | string;
  systemPrompt?: string;
  promptTemplate?: (ctx: TContext) => string;
  executor?: (ctx: TContext, signal?: AbortSignal) => Promise<string | StageResult>;
  gateRules?: QualityGateRule<TContext>[];
  enableGate?: boolean;
  gateHandler?: QualityGateHandler<TContext>;
  transformOutput?: (output: string, ctx: TContext) => string | Promise<string>;
}

export interface WorkflowContext {
  id?: string;
  title?: string;
  sectionTitle?: string;
  userPrompt: string;
  stateLedger: StateLedger;
  stageOutputs: Record<string, string>;
  stageLogs: Array<{ stageId: string; role: string; content: string; timestamp: number }>;
  qualityIssues?: QualityGateIssue[];
  metadata?: Record<string, unknown>;
}

export type WorkflowEvent =
  | { type: 'stage_start'; stage: string; stageId?: string; role: string }
  | { type: 'stage_progress'; stage: string; stageId?: string; role: string; delta: string }
  | { type: 'stage_end'; stage: string; stageId?: string; role: string; result: string }
  | {
      type: 'quality_gate_triggered';
      issues: QualityGateIssue[];
      content: string;
      stageId?: string;
    }
  | {
      type: 'quality_gate_resolved';
      approved: boolean;
      modifiedContent?: string;
      feedback?: string;
      stageId?: string;
    }
  | { type: 'workflow_complete'; result: WorkflowContext };

export type WorkflowEventListener = (event: WorkflowEvent) => void | Promise<void>;
