/**
 * InkPi JSON-RPC 2.0 协议标准定义
 */

import type {
  Artifact,
  ArtifactGetParams,
  ArtifactListParams,
  ArtifactSaveParams,
  ArtifactSaveResult
} from './artifact.js';
import type { CacheInvalidateParams, CacheInvalidateResult, CacheStatus } from './cache.js';
import type {
  DomainChangeSet,
  DomainProjectionApplyResult,
  DomainProjectionCursor,
  DomainProjectionSnapshot,
  DomainSyncPullParams,
  DomainSyncPushParams,
  DomainSyncRestoreParams,
  DomainSyncSnapshotParams
} from './domain-sync.js';
import type { GhostTextSuggestion } from './editor.js';
import type { ToolExecuteParams, ToolRegistrationDescriptor } from './extensions.js';
import type {
  InstructionDefinition,
  InstructionEntry,
  InstructionListParams,
  InstructionRegisterParams,
  InstructionRegisterResult,
  InstructionRegistryStatus
} from './instructions.js';
import type { AgentMessage, ModelConfig, ToolResultMessage } from './messages.js';
import type {
  ProposalProjectionSnapshot,
  ProposalSyncPushParams,
  ProposalSyncPushResult,
  ProposalSyncSnapshotParams
} from './proposal-sync.js';
import type { RuntimeHandshakeRequest, RuntimeHandshakeResponse } from './runtime-contract.js';
import type {
  RuntimeModelRouteHealthParams,
  RuntimeModelRouteHealthResult,
  RuntimeModelRouteRemoveParams,
  RuntimeModelRouteRemoveResult,
  RuntimeModelRouteSummary,
  RuntimeModelRoutesConfigureParams,
  RuntimeModelRoutesConfigureResult
} from './runtime-model.js';
import type {
  SkillActivateParams,
  SkillActivationResult,
  SkillDiscoverResult,
  SkillLoadParams,
  SkillLoadResult,
  SkillResolveQuery,
  SkillResolveResult,
  SkillRuntimeRegistrationSnapshot
} from './skills.js';
import type { SessionEntry, WorkspacePurgeParams, WorkspacePurgeResult } from './storage.js';
import type {
  TaskCancelParams,
  TaskCancelResult,
  TaskExecutionParams,
  TaskExecutionSnapshot,
  TaskForkParams,
  TaskReplayParams,
  TaskResumeParams,
  TaskStatusParams,
  TaskStatusSnapshot,
  TaskSteerParams,
  TaskSteerResult,
  TaskSubmitParams,
  TaskSubmitResult
} from './task.js';

export interface RpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: T;
}

export interface RpcResponseSuccess<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result: T;
  error?: never;
}

export interface RpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponseError {
  jsonrpc: '2.0';
  id: string | number;
  error: RpcErrorObject;
  result?: never;
}

export type RpcResponse<T = unknown> = RpcResponseSuccess<T> | RpcResponseError;

export interface RpcNotification<T = unknown> {
  jsonrpc: '2.0';
  method: string;
  params: T;
}

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AGENT_ABORTED: -32001,
  LEASE_LOCKED: -32002,
  STORAGE_ERROR: -32003
} as const;

/** Daemon liveness snapshot returned by `daemon.status`. */
export interface DaemonStatus {
  running: boolean;
  port?: number;
  host?: string;
  wsPort?: number | null;
  activeSessions: number;
  uptimeMs: number;
}

export interface SessionCreateOptions {
  sessionId?: string;
  model?: ModelConfig | string;
  initialText?: string;
  systemPrompt?: string;
  metadata?: Record<string, unknown>;
  entries?: SessionEntry[];
}

export interface SessionSummary {
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
  messageCount: number;
  documentLength: number;
  hasGhostText: boolean;
  metadata?: Record<string, unknown>;
}

export interface SessionRefParams {
  sessionId: string;
}

export interface SessionAckResult {
  success: boolean;
}

export interface SessionCreateResult {
  sessionId: string;
  createdAt: number;
  messageCount: number;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: string;
}

export interface SessionPromptResult {
  success: boolean;
  sessionId: string;
  messageCount: number;
  lastMessage?: AgentMessage;
}

export interface SessionStateResult {
  sessionId: string;
  messages: AgentMessage[];
  isStreaming: boolean;
  editorText: string;
  hasGhostText: boolean;
  ghostText: GhostTextSuggestion | null;
}

export interface SessionEditorInsertParams {
  sessionId: string;
  pos: number;
  text: string;
}

export interface SessionEditorTextResult {
  text: string;
  version: number;
}

export interface SessionEditorEditResult {
  success: boolean;
  text: string;
}

export interface SessionGhostSuggestParams {
  sessionId: string;
  text: string;
  pos?: number;
}

export interface SessionGhostAcceptParams {
  sessionId: string;
  mode?: 'all' | 'word' | 'line';
}

export interface SessionGhostAcceptResult {
  accepted: boolean;
  text: string;
}

/** `instruction.register` also accepts the bare forms the daemon normalizes into the envelope. */
export type InstructionRegisterRpcParams = InstructionRegisterParams | InstructionDefinition | InstructionDefinition[];

export interface RpcMethodContract<TParams, TResult> {
  params: TParams;
  result: TResult;
}

/**
 * The daemon's whole advertised surface, declared once. `InkRpcServer.registerMethod`
 * narrows its handler to this contract for every name listed here, so a params or
 * result drift is a compile error at the registration instead of a wire surprise.
 */
export interface DaemonRpcMethodMap {
  'artifact.get': RpcMethodContract<ArtifactGetParams, Artifact | null>;
  'artifact.list': RpcMethodContract<ArtifactListParams, Artifact[]>;
  'artifact.save': RpcMethodContract<ArtifactSaveParams, ArtifactSaveResult>;
  'cache.invalidate': RpcMethodContract<CacheInvalidateParams, CacheInvalidateResult>;
  'cache.status': RpcMethodContract<void, CacheStatus>;
  'daemon.status': RpcMethodContract<void, DaemonStatus>;
  'domain.sync.pull': RpcMethodContract<DomainSyncPullParams, DomainChangeSet[]>;
  'domain.sync.push': RpcMethodContract<DomainSyncPushParams, DomainProjectionApplyResult>;
  'domain.sync.restore': RpcMethodContract<DomainSyncRestoreParams, DomainProjectionCursor>;
  'domain.sync.snapshot': RpcMethodContract<DomainSyncSnapshotParams, DomainProjectionSnapshot>;
  'instruction.list': RpcMethodContract<InstructionListParams, InstructionEntry[]>;
  'instruction.register': RpcMethodContract<InstructionRegisterRpcParams, InstructionRegisterResult>;
  'instruction.status': RpcMethodContract<void, InstructionRegistryStatus>;
  'model.routes.configure': RpcMethodContract<RuntimeModelRoutesConfigureParams, RuntimeModelRoutesConfigureResult>;
  'model.routes.health': RpcMethodContract<RuntimeModelRouteHealthParams, RuntimeModelRouteHealthResult>;
  'model.routes.list': RpcMethodContract<void, RuntimeModelRouteSummary[]>;
  'model.routes.remove': RpcMethodContract<RuntimeModelRouteRemoveParams, RuntimeModelRouteRemoveResult>;
  'proposal.sync.push': RpcMethodContract<ProposalSyncPushParams, ProposalSyncPushResult>;
  'proposal.sync.snapshot': RpcMethodContract<ProposalSyncSnapshotParams, ProposalProjectionSnapshot>;
  'runtime.handshake': RpcMethodContract<RuntimeHandshakeRequest, RuntimeHandshakeResponse>;
  'session.abort': RpcMethodContract<SessionRefParams, SessionAckResult>;
  'session.close': RpcMethodContract<SessionRefParams, SessionAckResult>;
  'session.create': RpcMethodContract<SessionCreateOptions, SessionCreateResult>;
  'session.editor.insert': RpcMethodContract<SessionEditorInsertParams, SessionEditorTextResult>;
  'session.editor.redo': RpcMethodContract<SessionRefParams, SessionEditorEditResult>;
  'session.editor.undo': RpcMethodContract<SessionRefParams, SessionEditorEditResult>;
  'session.ghost.accept': RpcMethodContract<SessionGhostAcceptParams, SessionGhostAcceptResult>;
  'session.ghost.dismiss': RpcMethodContract<SessionRefParams, SessionAckResult>;
  'session.ghost.suggest': RpcMethodContract<SessionGhostSuggestParams, GhostTextSuggestion>;
  'session.getState': RpcMethodContract<SessionRefParams, SessionStateResult>;
  'session.get_state': RpcMethodContract<SessionRefParams, SessionStateResult>;
  'session.list': RpcMethodContract<void, SessionSummary[]>;
  'session.prompt': RpcMethodContract<SessionPromptParams, SessionPromptResult>;
  'skill.activate': RpcMethodContract<SkillActivateParams, SkillActivationResult>;
  'skill.discover': RpcMethodContract<void, SkillDiscoverResult>;
  'skill.list': RpcMethodContract<void, SkillDiscoverResult>;
  'skill.load': RpcMethodContract<SkillLoadParams, SkillLoadResult>;
  'skill.resolve': RpcMethodContract<SkillResolveQuery, SkillResolveResult>;
  'skill.snapshot': RpcMethodContract<void, SkillRuntimeRegistrationSnapshot>;
  'skill.status': RpcMethodContract<void, SkillRuntimeRegistrationSnapshot>;
  'task.cancel': RpcMethodContract<TaskCancelParams, TaskCancelResult>;
  'task.execution': RpcMethodContract<TaskExecutionParams, TaskExecutionSnapshot>;
  'task.fork': RpcMethodContract<TaskForkParams, TaskSubmitResult>;
  'task.replay': RpcMethodContract<TaskReplayParams, TaskSubmitResult>;
  'task.resume': RpcMethodContract<TaskResumeParams, TaskSubmitResult>;
  'task.status': RpcMethodContract<TaskStatusParams, TaskStatusSnapshot>;
  'task.steer': RpcMethodContract<TaskSteerParams, TaskSteerResult>;
  'task.submit': RpcMethodContract<TaskSubmitParams, TaskSubmitResult>;
  'tool.execute': RpcMethodContract<ToolExecuteParams, ToolResultMessage>;
  'tool.list': RpcMethodContract<void, ToolRegistrationDescriptor[]>;
  'workspace.purge': RpcMethodContract<WorkspacePurgeParams, WorkspacePurgeResult>;
}

export type DaemonRpcMethodName = keyof DaemonRpcMethodMap;

/**
 * The same surface as {@link DaemonRpcMethodMap} at runtime, for capability negotiation and
 * for the drift gate that compares it against the daemon's actual registrations. The compiler
 * keeps the two in sync: a name listed here must exist in the map.
 */
export const DAEMON_RPC_METHOD_NAMES = [
  'artifact.get',
  'artifact.list',
  'artifact.save',
  'cache.invalidate',
  'cache.status',
  'daemon.status',
  'domain.sync.pull',
  'domain.sync.push',
  'domain.sync.restore',
  'domain.sync.snapshot',
  'instruction.list',
  'instruction.register',
  'instruction.status',
  'model.routes.configure',
  'model.routes.health',
  'model.routes.list',
  'model.routes.remove',
  'proposal.sync.push',
  'proposal.sync.snapshot',
  'runtime.handshake',
  'session.abort',
  'session.close',
  'session.create',
  'session.editor.insert',
  'session.editor.redo',
  'session.editor.undo',
  'session.getState',
  'session.get_state',
  'session.ghost.accept',
  'session.ghost.dismiss',
  'session.ghost.suggest',
  'session.list',
  'session.prompt',
  'skill.activate',
  'skill.discover',
  'skill.list',
  'skill.load',
  'skill.resolve',
  'skill.snapshot',
  'skill.status',
  'task.cancel',
  'task.execution',
  'task.fork',
  'task.replay',
  'task.resume',
  'task.status',
  'task.steer',
  'task.submit',
  'tool.execute',
  'tool.list',
  'workspace.purge'
] as const satisfies readonly DaemonRpcMethodName[];

export type DaemonRpcParams<K> = K extends DaemonRpcMethodName ? DaemonRpcMethodMap[K]['params'] : unknown;

export type DaemonRpcResult<K> = K extends DaemonRpcMethodName ? DaemonRpcMethodMap[K]['result'] : unknown;

export type DaemonRpcHandlerFor<K> = (params: DaemonRpcParams<K>) => DaemonRpcResult<K> | Promise<DaemonRpcResult<K>>;

/** Registration names outside {@link DaemonRpcMethodMap} keep the historical untyped handler. */
export type LooseRpcMethodHandler = (params: any) => Promise<any> | any;

/**
 * Handler type a server should accept for a method name: contracted names get their declared
 * params/result, anything else keeps the pre-contract loose signature.
 */
export type RpcMethodRegistrationHandler<K> = K extends DaemonRpcMethodName
  ? DaemonRpcHandlerFor<K>
  : LooseRpcMethodHandler;
