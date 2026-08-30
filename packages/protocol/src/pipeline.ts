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
  [key: string]: unknown;
}

export interface QualityGateDecision {
  approved: boolean;
  modifiedContent?: string;
  modifiedOutlineText?: string;
  feedback?: string;
  [key: string]: unknown;
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
  workspaceTitle?: string;
  documentTitle?: string;
  bookTitle?: string;
  chapterTitle?: string;
  outlineText?: string;
  [key: string]: unknown;
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
  bookTitle?: string;
  workspaceTitle?: string;
  chapterTitle?: string;
  documentTitle?: string;
  userPrompt: string;
  stateLedger: StateLedger;
  stageOutputs: Record<string, string>;
  stageLogs: Array<{ stageId: string; role: string; content: string; timestamp: number }>;
  qualityIssues?: QualityGateIssue[];
  qualityGateIssues?: QualityGateIssue[];
  plotGateIssues?: QualityGateIssue[];
  outlineText?: string;
  draftText?: string;
  auditNotes?: string[];
  polishedText?: string;
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export type WorkflowEvent =
  | { type: 'stage_start'; stage: string; stageId?: string; role: string }
  | { type: 'stage_progress'; stage: string; stageId?: string; role: string; delta: string }
  | { type: 'stage_end'; stage: string; stageId?: string; role: string; result: string }
  | { type: 'quality_gate_triggered' | 'plot_gate_triggered'; issues: QualityGateIssue[]; outlineText?: string; gateContent?: string; stageId?: string }
  | { type: 'quality_gate_resolved' | 'plot_gate_resolved'; approved: boolean; modifiedOutlineText?: string; modifiedContent?: string; feedback?: string; stageId?: string }
  | { type: 'pipeline_complete'; result: WorkflowContext };

export type WorkflowEventListener = (event: WorkflowEvent) => void | Promise<void>;
