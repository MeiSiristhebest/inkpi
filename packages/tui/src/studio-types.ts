import type { SelectListOptions, TypographyOptions } from '@inkpi/protocol';
import type { Agent, SessionTree } from '@inkpi/agent-core';

export type StudioFocusMode = 'editor' | 'outline' | 'copilot' | 'ledger';

export interface StudioResourceItem {
  id: string;
  title: string;
  wordCount: number;
  status?: string;
  active: boolean;
}

export interface StudioLabels {
  leftBoxTitle?: string;
  editorTitle?: string;
  rightBoxTitle?: string;
  entitiesHeader?: string;
  assetsHeader?: string;
  tracksHeader?: string;
  dialogueHeader?: string;
  emptyContentText?: string;
  emptyEntitiesText?: string;
  emptyAssetsText?: string;
  emptyTracksText?: string;
  emptyDialogueText?: string;
  statusReady?: string;
  processingText?: string;
  ghostSuggestion?: string;
  acceptSuggestion?: string;
  focusStatus?: (mode: StudioFocusMode) => string;
  resourceMetric?: (wordCount: number) => string;
  insertedStatus?: (count: number) => string;
  commandExecutedStatus?: (command: string) => string;
  statusBarTitle?: string;
  statusBarWords?: string;
  statusBarFocus?: string;
  userRole?: string;
  assistantRole?: string;
}

export interface TerminalStudioOptions {
  agent?: Agent;
  tree?: SessionTree;
  width?: number;
  height?: number;
  initialResources?: StudioResourceItem[];
  labels?: Partial<StudioLabels>;
  typography?: (Partial<TypographyOptions> & { mode?: 'chinese' | 'western' | 'none' }) | false;
}

/** Studio 模态框类型。 */
export type StudioModalKind = 'selectList' | 'input' | null;

/** 状态栏闪烁消息。 */
export interface StudioFlashMessage {
  text: string;
  level: 'info' | 'success' | 'warning' | 'error';
  expiresAt: number;
}

/** 对话流条目。 */
export interface StudioDialogueEntry {
  role: string;
  text: string;
  timestamp: number;
}

/** `openSelectList` 的公开签名（保持与原 TerminalStudio 一致）。 */
export type StudioSelectListOptions<T> = SelectListOptions<T>;
