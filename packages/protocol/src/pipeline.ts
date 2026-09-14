import type { Usage } from './messages.js';

/**
 * State owned by a caller-supplied adapter.
 *
 * Runtime does not interpret this object as a novel, document, character, or
 * any other product-domain model.  A composition root may provide a more
 * specific state type through the generic parameter.
 */
export interface RuntimeState {
  [key: string]: any;
}

/**
 * Explicit state boundary for workflows.  The Runtime can carry and merge
 * opaque state, but it never invents domain meaning or writes an authoritative
 * store on its own.
 */
export interface WorkflowStateAdapter<TState extends RuntimeState = RuntimeState> {
  createInitialState(): TState;
  merge(base: TState, patch: unknown): TState;
  format?(state: TState): string;
}

export type GateSeverity = 'info' | 'warning' | 'critical';

export interface QualityGateIssue {
  type: string;
  description: string;
  /** Optional opaque target identifier supplied by the caller's adapter. */
  target?: string;
  severity: GateSeverity;
  metadata?: Record<string, unknown>;
}

export interface QualityGateDecision {
  approved: boolean;
  modifiedContent?: string;
  feedback?: string;
}

export interface QualityGateRule<TContext = unknown> {
  id?: string;
  type: string;
  pattern?: RegExp | string;
  detector?(content: string, context?: TContext, metadata?: unknown): QualityGateIssue | null;
  severity: GateSeverity;
  description: string;
}

export type QualityGateHandler<TContext = WorkflowContext> = (event: {
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
  /** Optional opaque state patch handled by an injected WorkflowStateAdapter. */
  statePatch?: unknown;
}

export interface WorkflowStageConfig<TContext = WorkflowContext> {
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

export interface WorkflowContext<TState extends RuntimeState = RuntimeState> {
  /** Canonical, domain-neutral workflow input. */
  input: string;
  /** Opaque state owned and interpreted by the composition root. */
  state: TState;
  /** Canonical stage output map. */
  outputs: Record<string, string>;
  /** Canonical stage log. */
  logs: Array<{ stageId: string; role: string; content: string; timestamp: number }>;

  /** @deprecated Compatibility aliases. Use input/state/outputs/logs instead. */
  id?: string;
  title?: string;
  sectionTitle?: string;
  /** @deprecated Compatibility alias for input; no product-domain semantics. */
  userPrompt: string;
  /** @deprecated Compatibility alias for state; no default domain interpretation. */
  stateLedger: TState;
  /** @deprecated Compatibility alias for outputs. */
  stageOutputs: Record<string, string>;
  /** @deprecated Compatibility alias for logs. */
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
