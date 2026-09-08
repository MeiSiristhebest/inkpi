/**
 * Domain-neutral task contracts shared by desktop clients and the AI runtime.
 * Creative task kinds stay open strings so the runtime does not import a
 * product-specific domain vocabulary.
 */

export interface TaskSelection {
  documentId: string;
  from: number;
  to: number;
  blockIds?: string[];
  revision?: number;
}

export interface TaskInput {
  text?: string;
  documentId?: string;
  selection?: TaskSelection;
  payload?: unknown;
}

export interface ContextPolicy {
  providerIds?: string[];
  maxTokens?: number;
  maxFragments?: number;
  includeSelection?: boolean;
  includeProjectState?: boolean;
  metadata?: Record<string, unknown>;
}

export type ExecutionStrategy = 'completion' | 'reasoning' | 'workflow' | 'agent';
export type ExecutionMode = 'interactive' | 'foreground' | 'background' | 'batch';
export type SchedulingPolicy = ExecutionMode;
export type TaskPriority = 'low' | 'normal' | 'high';

export interface CheckpointPolicy {
  enabled?: boolean;
  intervalMs?: number;
  /** A workflow may use a stable step identifier for restart and resume. */
  step?: string;
}

export interface ExecutionPolicy {
  strategy?: ExecutionStrategy;
  mode?: ExecutionMode;
  /** Alias used by clients that call the scheduling dimension explicitly. */
  scheduling?: ExecutionMode;
  priority?: number | TaskPriority;
  timeoutMs?: number;
  maxAttempts?: number;
  cancellable?: boolean;
  checkpointIntervalMs?: number;
  checkpoint?: CheckpointPolicy;
}

export type OutputFormat = 'text' | 'structured' | 'patch';
export type OutputPersistence = 'ephemeral' | 'session' | 'artifact';

export interface OutputContract {
  format: OutputFormat;
  schemaId?: string;
  persistence?: OutputPersistence;
  allowEmpty?: boolean;
}

export type EffectMode = 'read-only' | 'proposal';

export interface EffectPolicy {
  mode: EffectMode;
  requiresApproval?: boolean;
  allowedScopes?: string[];
}

export interface TaskRequirements {
  capabilities?: string[];
  tools?: string[];
  modalities?: string[];
  network?: 'offline' | 'optional' | 'required';
  outputFormats?: OutputFormat[];
  streaming?: boolean;
  minContextTokens?: number;
  maxLatencyMs?: number;
  maxCostUsd?: number;
  needsTools?: boolean;
  needsStructuredOutput?: boolean;
  needsReasoning?: boolean;
  needsStreaming?: boolean;
  minimumContext?: number;
}

export interface AiTask {
  id: string;
  kind: string;
  input: TaskInput;
  contextPolicy?: ContextPolicy;
  executionPolicy?: ExecutionPolicy;
  outputContract?: OutputContract;
  effectPolicy?: EffectPolicy;
  requirements?: TaskRequirements;
  /** Optional public intent kept separate from the assembled context. */
  intent?: string;
  checkpointPolicy?: CheckpointPolicy;
  metadata?: Record<string, unknown>;
}

export interface TextTaskOutput {
  format: 'text';
  text: string;
}

export interface StructuredTaskOutput {
  format: 'structured';
  data: unknown;
}

export interface PatchTaskOutput {
  format: 'patch';
  patch: unknown;
}

export type TaskOutput = TextTaskOutput | StructuredTaskOutput | PatchTaskOutput;

export type TaskStatus =
  | 'created'
  | 'queued'
  | 'running'
  | 'checkpointed'
  | 'waiting-user'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TaskTerminalStatus = 'waiting-user' | 'completed' | 'failed' | 'cancelled';

export interface TaskError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: unknown;
}

export interface TaskResult {
  taskId: string;
  kind: string;
  status: TaskTerminalStatus;
  output?: TaskOutput;
  error?: TaskError;
  artifactIds?: string[];
  proposalIds?: string[];
  provenance?: Record<string, unknown>;
}

export interface TaskStatusSnapshot {
  taskId: string;
  kind: string;
  status: TaskStatus;
  progress?: number;
  result?: TaskResult;
  error?: TaskError;
  startedAt?: number;
  finishedAt?: number;
  executionRunId?: string;
  attempts?: number;
  checkpoint?: { step: string; updatedAt: number };
}

export interface TaskSubmitParams {
  task: AiTask;
}

export interface TaskSubmitResult {
  taskId: string;
  status: TaskStatus;
}

export interface TaskCancelParams {
  taskId: string;
}

export interface TaskCancelResult {
  taskId: string;
  cancelled: boolean;
  status: TaskStatus;
}

export interface TaskStatusParams {
  taskId: string;
}

export interface TaskResumeParams {
  taskId: string;
}

export interface TaskSteerParams {
  taskId: string;
  input: unknown;
}

export interface TaskSteerResult {
  taskId: string;
  accepted: boolean;
}

export interface TaskReplayParams {
  taskId: string;
  replayTaskId?: string;
}

export interface TaskForkParams {
  taskId: string;
  forkTaskId: string;
  patch?: Partial<AiTask>;
}
