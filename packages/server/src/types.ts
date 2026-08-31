import type {
  RpcRequest,
  RpcResponse,
  RpcNotification,
  AgentMessage,
  ModelConfig
} from '@inkpi/protocol';
import type { HeadlessEditorState, GhostTextManager } from '@inkpi/editor-core';
import type { ISessionBackend } from '@inkpi/session-backends';

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
