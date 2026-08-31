import type {
  AgentMessage,
  ExtensionAPI,
  ExtensionModule,
  ExtensionFactory,
  CommandHandler,
  ShortcutHandler,
  ContextTransformer,
  PipelineHooks,
  SelectListOptions,
  InputDialogOptions,
  FlashNotificationOptions,
  UIDelegate
} from '@inkpi/protocol';

export interface CommandDefinition {
  name: string;
  description?: string;
  execute?: (args: string) => Promise<any> | any;
  handler?: CommandHandler;
}

/**
 * 纯通用扩展宿主核心 (1:1 对标 repos/pi packages/extensions 微内核架构)
 * 提供无侵入生命周期事件订阅、自定义斜杠指令注册、键盘快捷键绑定、
 * 工具动态注入、上下文管道拦截以及终端 UI 弹窗调用原语。
 */
export class ExtensionHost implements ExtensionAPI {
  private listeners = new Map<string, Array<(...args: any[]) => void | Promise<void>>>();
  private commands = new Map<string, any>();
  private shortcuts = new Map<string, any>();
  private tools = new Map<string, any>();
  private transformers: ContextTransformer[] = [];
  private pipelineHooks: PipelineHooks[] = [];
  private uiDelegate?: UIDelegate;

  constructor(uiDelegate?: UIDelegate) {
    if (uiDelegate) {
      this.uiDelegate = uiDelegate;
    }
  }

  public setUIDelegate(delegate: UIDelegate): void {
    this.uiDelegate = delegate;
  }

  // -------------------------------------------------------------
  // 事件系统 (Event Bus)
  // -------------------------------------------------------------
  public on(event: string, listener: (...args: any[]) => void | Promise<void>): () => void {
    const list = this.listeners.get(event) || [];
    list.push(listener);
    this.listeners.set(event, list);
    return () => this.off(event, listener);
  }

  public off(event: string, listener: (...args: any[]) => void | Promise<void>): void {
    const list = this.listeners.get(event);
    if (!list) return;
    const idx = list.indexOf(listener);
    if (idx !== -1) {
      list.splice(idx, 1);
    }
  }

  public async emit(event: string, ...args: any[]): Promise<void> {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return;
    for (const listener of list) {
      try {
        await listener(...args);
      } catch (err) {
        console.error(`[ExtensionHost] Error executing event listener for '${event}':`, err);
      }
    }
  }

  // -------------------------------------------------------------
  // 工具注册 (Dynamic Tools)
  // -------------------------------------------------------------
  public registerTool(tool: any): () => void {
    this.tools.set(tool.name, tool);
    return () => {
      this.tools.delete(tool.name);
    };
  }

  public unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  public getTools(): any[] {
    return Array.from(this.tools.values());
  }

  // -------------------------------------------------------------
  // 斜杠指令 (Slash Commands)
  // -------------------------------------------------------------
  public registerCommand(
    nameOrConfig: string | CommandDefinition | any,
    handler?: CommandHandler
  ): () => void {
    let cleanName: string;
    if (typeof nameOrConfig === 'string') {
      cleanName = nameOrConfig.startsWith('/') ? nameOrConfig.slice(1) : nameOrConfig;
      this.commands.set(cleanName, {
        name: cleanName,
        handler: handler!,
        execute: handler!
      });
    } else {
      cleanName = (nameOrConfig.name || '').startsWith('/') ? nameOrConfig.name.slice(1) : nameOrConfig.name;
      this.commands.set(cleanName, nameOrConfig);
    }

    return () => {
      this.commands.delete(cleanName);
    };
  }

  public unregisterCommand(name: string): boolean {
    const cleanName = name.startsWith('/') ? name.slice(1) : name;
    return this.commands.delete(cleanName);
  }

  public getCommands(): any[] {
    return Array.from(this.commands.values());
  }

  public getCommand(name: string): any | undefined {
    const cleanName = name.startsWith('/') ? name.slice(1) : name;
    return this.commands.get(cleanName);
  }

  // -------------------------------------------------------------
  // 快捷键 (Shortcuts) & 上下文转换 (Transformers)
  // -------------------------------------------------------------
  public registerShortcut(
    keyOrConfig: string | { key: string; execute?: () => boolean | Promise<boolean>; handler?: ShortcutHandler; description?: string },
    handler?: ShortcutHandler
  ): () => void {
    const key = typeof keyOrConfig === 'string' ? keyOrConfig : keyOrConfig.key;
    const fn = typeof keyOrConfig === 'string' ? handler! : (keyOrConfig.handler || (() => {}));
    const shortcutObj = {
      key,
      handler: fn,
      execute: typeof keyOrConfig === 'object' && keyOrConfig.execute ? keyOrConfig.execute : async () => {
        if (typeof fn === 'function') {
          await (fn as any)();
        } else if (fn && typeof (fn as any).execute === 'function') {
          await (fn as any).execute();
        }
        return true;
      }
    };
    this.shortcuts.set(key, shortcutObj);
    return () => {
      this.shortcuts.delete(key);
    };
  }

  public unregisterShortcut(key: string): boolean {
    return this.shortcuts.delete(key);
  }

  public getShortcuts(): any[] {
    return Array.from(this.shortcuts.values());
  }

  public addContextTransformer(transformer: ContextTransformer): () => void {
    this.transformers.push(transformer);
    return () => {
      const idx = this.transformers.indexOf(transformer);
      if (idx !== -1) {
        this.transformers.splice(idx, 1);
      }
    };
  }

  public async transformContext(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
    let current = [...messages];
    for (const tf of this.transformers) {
      if (signal?.aborted) break;
      current = await tf(current, signal);
    }
    return current;
  }

  // -------------------------------------------------------------
  // UI 交互原语 (SelectList, Input, Flash)
  // -------------------------------------------------------------
  public async showSelectList<T>(options: SelectListOptions<T> | any): Promise<T | undefined> {
    if (this.uiDelegate?.showSelectList) {
      return this.uiDelegate.showSelectList(options);
    }
    return undefined;
  }

  public async showInput(options: InputDialogOptions): Promise<string | undefined> {
    if (this.uiDelegate?.showInput) {
      return this.uiDelegate.showInput(options);
    }
    return undefined;
  }

  public flashNotification(options: FlashNotificationOptions | string): void {
    if (this.uiDelegate?.flashNotification) {
      this.uiDelegate.flashNotification(options);
    }
  }

  // -------------------------------------------------------------
  // 生命周期钩子
  // -------------------------------------------------------------
  public registerPipelineHooks(hooks: PipelineHooks): () => void {
    this.pipelineHooks.push(hooks);
    return () => {
      const idx = this.pipelineHooks.indexOf(hooks);
      if (idx !== -1) this.pipelineHooks.splice(idx, 1);
    };
  }

  public registerNovelHooks(hooks: PipelineHooks): () => void {
    return this.registerPipelineHooks(hooks);
  }

  public getPipelineHooks(): PipelineHooks[] {
    return [...this.pipelineHooks];
  }

  public getNovelHooks(): PipelineHooks[] {
    return this.getPipelineHooks();
  }

  public clear(): void {
    this.listeners.clear();
    this.commands.clear();
    this.shortcuts.clear();
    this.tools.clear();
    this.transformers = [];
    this.pipelineHooks = [];
  }
}

export class ExtensionRunner {
  private host: ExtensionHost;
  private loadedModules = new Map<string, ExtensionModule>();

  constructor(host?: ExtensionHost) {
    this.host = host || new ExtensionHost();
  }

  public getApi(): ExtensionAPI {
    return this.host;
  }

  public getHost(): ExtensionHost {
    return this.host;
  }

  public async loadExtension(ext: ExtensionModule | ExtensionFactory | any, name?: string): Promise<boolean> {
    try {
      if (typeof ext === 'function') {
        await ext(this.host);
        const modName = name || 'anonymous-extension';
        this.loadedModules.set(modName, { name: modName, factory: ext });
      } else if (ext && typeof ext.factory === 'function') {
        await ext.factory(this.host);
        this.loadedModules.set(ext.name || name || 'anonymous-extension', ext);
      } else if (ext && typeof ext.init === 'function') {
        await ext.init(this.host);
        this.loadedModules.set(ext.name || name || 'anonymous-extension', ext);
      }
      return true;
    } catch (err) {
      console.error(`[ExtensionRunner] Failed to load extension:`, err);
      return false;
    }
  }

  public async loadAll(extensions: Array<{ name: string; factory: ExtensionFactory }>): Promise<void> {
    for (const ext of extensions) {
      await this.loadExtension(ext.factory, ext.name);
    }
  }

  public getLoadedModules(): ExtensionModule[] {
    return Array.from(this.loadedModules.values());
  }

  public getLoadedExtensions(): ExtensionModule[] {
    return this.getLoadedModules();
  }

  public getLoadedDocuments(): ExtensionModule[] {
    return this.getLoadedModules();
  }
}
