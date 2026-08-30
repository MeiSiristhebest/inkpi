import type { AgentMessage, TextContent, ImageContent } from './messages.js';

export type ToolExecutionMode = 'parallel' | 'sequential';

export interface ToolResult {
  content: (TextContent | ImageContent)[];
  details?: unknown;
  terminate?: boolean;
  isError?: boolean;
}

export interface AgentTool<TParams = any> {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters?: unknown; // TypeBox or JSON Schema
  readonly executionMode?: ToolExecutionMode;
  execute(
    toolCallId: string,
    params: TParams,
    signal?: AbortSignal,
    onUpdate?: (update: { content: TextContent[]; details?: unknown }) => void,
    context?: unknown
  ): Promise<ToolResult>;
  [key: string]: unknown;
}

export type CommandHandler = (args: string, context?: unknown) => Promise<any> | any;

export interface SlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly usage?: string;
  execute(args: string, context?: unknown): Promise<string | void> | (string | void);
  [key: string]: unknown;
}

export interface ShortcutHandler {
  readonly key: string; // e.g. "Tab", "Escape", "Ctrl+Shift+L"
  readonly description?: string;
  execute(context?: unknown): Promise<boolean | void> | boolean | void;
  [key: string]: unknown;
}

export interface ExtensionContext {
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly documentId?: string;
  readonly extra?: Record<string, unknown>;
}

export type ExtensionEventHandler = (...args: any[]) => Promise<void> | void;
export type ContextTransformer = (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;

export interface SelectListItem<T = any> {
  id: string;
  label: string;
  value: T;
  description?: string;
  [key: string]: unknown;
}

export interface SelectListOptions<T = any> {
  title: string;
  items?: SelectListItem<T>[];
  assets?: SelectListItem<T>[];
  initialIndex?: number;
  [key: string]: unknown;
}

export interface InputDialogOptions {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  password?: boolean;
  [key: string]: unknown;
}

export interface FlashNotificationOptions {
  message: string;
  level?: 'info' | 'success' | 'warning' | 'error';
  durationMs?: number;
  [key: string]: unknown;
}

export interface UIDelegate {
  showSelectList?<T>(options: SelectListOptions<T>): Promise<T | undefined>;
  showInput?(options: InputDialogOptions): Promise<string | undefined>;
  flashNotification?(options: FlashNotificationOptions | string): void;
}

export interface PipelineHooks {
  onBeforeOutline?: (ctx: { workspaceTitle?: string; documentTitle?: string; bookTitle?: string; chapterTitle?: string; sectionTitle?: string; userPrompt: string }) => Promise<string | void> | string | void;
  onBeforeDraft?: (ctx: { workspaceTitle?: string; documentTitle?: string; bookTitle?: string; chapterTitle?: string; sectionTitle?: string; userPrompt: string }) => Promise<string | void> | string | void;
  onDraftGenerated?: (ctx: { workspaceTitle?: string; documentTitle?: string; bookTitle?: string; chapterTitle?: string; sectionTitle?: string; draftText: string }) => Promise<string | void> | string | void;
  onAuditPass?: (ctx: { auditNotes: string[]; passed: boolean }) => Promise<void> | void;
  onPolishDone?: (ctx: { polishedText: string }) => Promise<string | void> | string | void;
  [key: string]: unknown;
}

export type NovelHooks = PipelineHooks;

/**
 * 纯净通用 ExtensionAPI 总线契约 (对标 repos/pi 官方 ExtensionAPI)
 * 具备 0 业务偏见，支持外部任意扩展注册工具、命令、快捷键、UI 交互与生命周期钩子
 */
export interface ExtensionAPI {
  on(eventName: string, handler: ExtensionEventHandler): () => void;
  emit(eventName: string, ...args: unknown[]): Promise<void>;
  registerTool(tool: AgentTool | any): void;
  unregisterTool(name: string): boolean;
  getTools(): AgentTool[] | any[];
  registerCommand(cmd: SlashCommand | any, handler?: any): void;
  unregisterCommand(name: string): boolean;
  getCommands(): SlashCommand[] | any[];
  registerShortcut(shortcut: ShortcutHandler | any, handler?: any): void;
  unregisterShortcut(key: string): boolean;
  getShortcuts(): ShortcutHandler[] | any[];
  transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
  addContextTransformer(transformer: ContextTransformer): () => void;

  // Pi 风格 UI 交互与弹窗接口
  showSelectList<T>(options: SelectListOptions<T>): Promise<T | undefined>;
  showInput(options: InputDialogOptions): Promise<string | undefined>;
  flashNotification(options: FlashNotificationOptions | string): void;

  // 内容创作生命周期钩子
  registerPipelineHooks(hooks: PipelineHooks): () => void;
  getPipelineHooks(): PipelineHooks[];
}

export type ExtensionFactory = (api: ExtensionAPI) => Promise<void> | void;

export interface ExtensionModule {
  name: string;
  version?: string;
  description?: string;
  factory: ExtensionFactory;
}
