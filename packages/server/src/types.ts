import type {
  RpcRequest,
  RpcResponse,
  RpcNotification,
  AgentMessage,
  ModelConfig
} from '@meisiristhebest/protocol';
import type { HeadlessEditorState, GhostTextManager } from '@meisiristhebest/editor-core';
import type { ISessionBackend } from '@meisiristhebest/session-backends';

export type RpcNotificationSender = (notification: RpcNotification) => void;

export interface ManagedSession {
  sessionId: string;
  editor: HeadlessEditorState;
  ghost: GhostTextManager;
  backend?: ISessionBackend;
  messages: AgentMessage[];
  createdAt: number;
  lastActiveAt: number;
  modelConfig?: ModelConfig;
}
