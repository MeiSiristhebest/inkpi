import type { AiTask, TaskOutput, ToolCallContent, ToolResultMessage } from '@inkpi/protocol';
import type { ContextPacket } from '../context/types.js';
import type { ComposedInstructions } from '../instructions/instruction-registry.js';
import type { ToolRegistry } from '../tools.js';
import type { TaskCheckpoint } from './checkpoints.js';

export interface TaskHandlerContext {
  task: AiTask;
  context: ContextPacket;
  instructions?: ComposedInstructions;
  signal: AbortSignal;
  executionRunId: string;
  attempt: number;
  /** Existing generic ToolRegistry, exposed without creating a second tool runtime. */
  toolRegistry?: ToolRegistry;
  executeTool?(call: ToolCallContent): Promise<ToolResultMessage & { terminate?: boolean }>;
  /** Returns and clears public human steering submitted while the task runs. */
  consumeSteering(): unknown[];
  checkpoint?: TaskCheckpoint;
  saveCheckpoint(step: string, data: unknown): Promise<void>;
  reportProgress(progress: number): void;
}

export interface TaskHandlerResult {
  output?: TaskOutput;
  status?: 'completed' | 'waiting-user';
  artifactIds?: string[];
  proposalIds?: string[];
  provenance?: Record<string, unknown>;
}

export interface TaskHandler {
  id: string;
  kinds?: readonly string[];
  canHandle?(task: AiTask): boolean;
  execute(context: TaskHandlerContext): Promise<TaskHandlerResult>;
}
