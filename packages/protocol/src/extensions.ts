import type { AgentMessage, ImageContent, TextContent } from './messages.js';

export type ToolExecutionMode = 'parallel' | 'sequential';

/**
 * 工具重放策略（对齐上游 pi tool-durability 的 `replay` 合约）：
 * - `'safe'`（默认）：中断后允许携带原 invocationId 重放（工具幂等或副作用可接受）；
 * - `'never'`：中断后绝不重跑外部副作用，恢复方必须合成"结果未知"的占位结果。
 */
export type ToolReplayPolicy = 'safe' | 'never';

/** 工具进度更新选项（对齐上游 pi tool-durability 的 checkpoint 请求）。 */
export interface ToolUpdateOptions {
  /**
   * 请求把本次**完整有界**进度快照持久化为 `tool_progress` journal 条目。
   * 这是持久化请求而非持久化确认；节流与快照有界性由工具自行负责（可信工具合约）。
   */
  checkpoint?: boolean;
}

export interface ToolResult {
  content: (TextContent | ImageContent)[];
  details?: unknown;
  terminate?: boolean;
  isError?: boolean;
}

/**
 * Agent 工具契约（协议层声明，宿主以 any 存取注册项以便扩展附加私有元数据）。
 * 只声明本包保证的字段；扩展若携带额外元数据，以运行时属性存在而不入协议类型。
 */
export interface AgentTool<TParams = any> {
  readonly name: string;
  readonly label?: string;
  readonly description: string;
  readonly parameters?: unknown; // TypeBox or JSON Schema
  readonly executionMode?: ToolExecutionMode;
  /** 中断后的重放策略，缺省视为 `'safe'`（见 {@link ToolReplayPolicy}）。 */
  readonly replay?: ToolReplayPolicy;
  execute(
    toolCallId: string,
    params: TParams,
    signal?: AbortSignal,
    onUpdate?: (update: { content: TextContent[]; details?: unknown }, options?: ToolUpdateOptions) => void,
    context?: unknown
  ): Promise<ToolResult>;
}

export type CommandHandler = (args: string, context?: unknown) => Promise<any> | any;

export interface SlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly argumentHint?: string;
  readonly usage?: string;
  execute(args: string, context?: unknown): Promise<string | undefined> | (string | undefined);
}

export interface ShortcutHandler {
  readonly key: string; // e.g. "Tab", "Escape", "Ctrl+Shift+L"
  readonly description?: string;
  execute(context?: unknown): Promise<boolean | undefined> | boolean | undefined;
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
}

export interface SelectListOptions<T = any> {
  title: string;
  items?: SelectListItem<T>[];
  assets?: SelectListItem<T>[];
  initialIndex?: number;
}

export interface InputDialogOptions {
  title: string;
  placeholder?: string;
  defaultValue?: string;
  password?: boolean;
}

export interface FlashNotificationOptions {
  message: string;
  level?: 'info' | 'success' | 'warning' | 'error';
  durationMs?: number;
}

export interface UIDelegate {
  showSelectList?<T>(options: SelectListOptions<T>): Promise<T | undefined>;
  showInput?(options: InputDialogOptions): Promise<string | undefined>;
  flashNotification?(options: FlashNotificationOptions | string): void;
}

export interface PipelineHooks {
  /** Generic lifecycle hook. Prefer this over stage-name-specific hooks. */
  onBeforeStage?: (ctx: {
    stageId: string;
    context: unknown;
    prompt: string;
  }) => Promise<string | undefined> | string | undefined;
  /** Generic lifecycle hook. Prefer this over stage-name-specific hooks. */
  onAfterStage?: (ctx: {
    stageId: string;
    context: unknown;
    output: string;
  }) => Promise<string | undefined> | string | undefined;
  /** Generic output notification after a stage has settled. */
  onStageOutput?: (ctx: {
    stageId: string;
    context: unknown;
    output: string;
  }) => Promise<void> | void;
  /** @deprecated Use generic lifecycle hooks above. */
  onBeforeOutline?: (ctx: {
    workspaceTitle?: string;
    documentTitle?: string;
    bookTitle?: string;
    chapterTitle?: string;
    sectionTitle?: string;
    userPrompt: string;
  }) => Promise<string | undefined> | string | undefined;
  /** @deprecated Use generic lifecycle hooks above. */
  onBeforeDraft?: (ctx: {
    workspaceTitle?: string;
    documentTitle?: string;
    bookTitle?: string;
    chapterTitle?: string;
    sectionTitle?: string;
    userPrompt: string;
  }) => Promise<string | undefined> | string | undefined;
  /** @deprecated Use generic lifecycle hooks above. */
  onDraftGenerated?: (ctx: {
    workspaceTitle?: string;
    documentTitle?: string;
    bookTitle?: string;
    chapterTitle?: string;
    sectionTitle?: string;
    draftText: string;
  }) => Promise<string | undefined> | string | undefined;
  /** @deprecated Use generic lifecycle hooks above. */
  onAuditPass?: (ctx: { auditNotes: string[]; passed: boolean }) => Promise<void> | void;
  /** @deprecated Use generic lifecycle hooks above. */
  onPolishDone?: (ctx: { polishedText: string }) => Promise<string | undefined> | string | undefined;
}

export type NovelHooks = PipelineHooks;

/**
 * 扩展能力面（capability facets）——按职责拆分的窄接口。
 *
 * 背景：`ExtensionAPI` 曾是 17 个方法挤在一起的胖接口，宿主与扩展只能整体实现 /
 * 整体依赖，无法表达"某扩展只需要工具注册"这类最小权限诉求。
 * 现将每一组内聚方法声明为独立能力面，`ExtensionAPI` 聚合它们（extends），
 * 保持既有的聚合类型名与所有实现/消费点不变；新增的窄面供按需依赖注入。
 */

/** 事件总线：发布 / 订阅领域事件 */
export interface ExtensionEventBus {
  on(eventName: string, handler: ExtensionEventHandler): () => void;
  emit(eventName: string, ...args: unknown[]): Promise<void>;
}

/** 工具注册表：增删查 Agent Tool */
export interface ExtensionToolRegistry {
  registerTool(tool: AgentTool | any): void;
  unregisterTool(name: string): boolean;
  getTools(): AgentTool[] | any[];
}

/** 斜杠命令注册表：增删查 Slash Command */
export interface ExtensionCommandRegistry {
  registerCommand(cmd: SlashCommand | any, handler?: any): void;
  unregisterCommand(name: string): boolean;
  getCommands(): SlashCommand[] | any[];
}

/** 快捷键注册表：增删查 Shortcut */
export interface ExtensionShortcutRegistry {
  registerShortcut(shortcut: ShortcutHandler | any, handler?: any): void;
  unregisterShortcut(key: string): boolean;
  getShortcuts(): ShortcutHandler[] | any[];
}

/** 上下文转换链：改写送入模型的消息序列 */
export interface ExtensionContextTransformers {
  transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
  addContextTransformer(transformer: ContextTransformer): () => void;
}

/** 宿主 UI 交互面：选择列表 / 输入框 / 闪屏通知 */
export interface ExtensionUi {
  showSelectList<T>(options: SelectListOptions<T>): Promise<T | undefined>;
  showInput(options: InputDialogOptions): Promise<string | undefined>;
  flashNotification(options: FlashNotificationOptions | string): void;
}

/** 写作流水线生命周期钩子注册面 */
export interface ExtensionPipelineHooks {
  registerPipelineHooks(hooks: PipelineHooks): () => void;
  getPipelineHooks(): PipelineHooks[];
}

/**
 * 纯净通用 ExtensionAPI 总线契约（对外聚合面，等价于各能力面的并集）。
 * 具备 0 业务偏见，支持外部任意扩展注册工具、命令、快捷键、UI 交互与生命周期钩子。
 * 需要最小权限注入时，请引用具体能力面而非本聚合接口。
 */
export interface ExtensionAPI
  extends ExtensionEventBus,
    ExtensionToolRegistry,
    ExtensionCommandRegistry,
    ExtensionShortcutRegistry,
    ExtensionContextTransformers,
    ExtensionUi,
    ExtensionPipelineHooks {}

export type ExtensionFactory = (api: ExtensionAPI) => Promise<void> | void;

export interface ExtensionModule {
  name: string;
  version?: string;
  description?: string;
  factory: ExtensionFactory;
}
