import type {
  AgentMessage,
  CommandHandler,
  ContextTransformer,
  ExtensionAPI,
  ExtensionFactory,
  ExtensionModule,
  ExtensionToolHooks,
  FlashNotificationOptions,
  InputDialogOptions,
  PipelineHooks,
  SelectListOptions,
  ShortcutHandler,
  ToolRegistrationDescriptor,
  ToolRegistrationOptions,
  UIDelegate
} from '@inkpi/protocol';
import { ExtensionGeneration } from './extension-generation.js';
import { consoleLogger } from './ports/index.js';
import { createToolRegistrationDescriptor } from './tools.js';

type ToolHooks = Parameters<ExtensionToolHooks['registerToolHooks']>[0];

/** @internal Registration identities used for atomic generation replacement. */
export interface ExtensionMount {
  readonly tools: ReadonlyMap<string, any>;
  readonly commands: ReadonlyMap<string, any>;
  readonly shortcuts: ReadonlyMap<string, any>;
  owns(kind: 'tools' | 'commands' | 'shortcuts', name: string): boolean;
  dispose(): void;
}

export interface CommandDefinition {
  name: string;
  description?: string;
  execute?: (args: string) => Promise<any> | any;
  handler?: CommandHandler;
}

/**
 * 纯通用扩展宿主核心
 * 提供无侵入生命周期事件订阅、自定义斜杠指令注册、键盘快捷键绑定、
 * 工具动态注入、上下文管道拦截以及终端 UI 弹窗调用原语。
 */
export class ExtensionHost implements ExtensionAPI {
  private listeners = new Map<string, Array<(...args: any[]) => void | Promise<void>>>();
  private commands = new Map<string, any>();
  private shortcuts = new Map<string, any>();
  private tools = new Map<string, any>();
  private toolRegistrations = new Map<string, ToolRegistrationDescriptor>();
  private transformers: ContextTransformer[] = [];
  private pipelineHooks: PipelineHooks[] = [];
  private toolHooks: ToolHooks[] = [];
  private uiDelegate?: UIDelegate;
  private readonly generationInvalidators = new Set<() => void>();
  private readonly registrationTokens = {
    tools: new Map<string, symbol>(),
    commands: new Map<string, symbol>(),
    shortcuts: new Map<string, symbol>()
  };

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
    for (const listener of [...list]) {
      try {
        await listener(...args);
      } catch (err) {
        consoleLogger.error(`[ExtensionHost] Error executing event listener for '${event}':`, err);
      }
    }
  }

  // -------------------------------------------------------------
  // 工具注册 (Dynamic Tools)
  // -------------------------------------------------------------
  public registerTool(tool: any, options: ToolRegistrationOptions = {}): () => void {
    const descriptor = createToolRegistrationDescriptor(tool, options);
    this.tools.set(tool.name, tool);
    this.toolRegistrations.set(tool.name, descriptor);
    const token = Symbol();
    this.registrationTokens.tools.set(tool.name, token);
    return () => {
      if (this.registrationTokens.tools.get(tool.name) === token) this.unregisterTool(tool.name);
    };
  }

  public unregisterTool(name: string): boolean {
    const removed = this.tools.delete(name);
    this.toolRegistrations.delete(name);
    this.registrationTokens.tools.delete(name);
    return removed;
  }

  public getTools(): any[] {
    return Array.from(this.tools.values());
  }

  /** Returns serializable metadata for Desktop/Daemon registration handshakes. */
  public getToolRegistrations(): ToolRegistrationDescriptor[] {
    return Array.from(this.toolRegistrations.values()).map((registration) => ({
      ...registration,
      capabilities: [...registration.capabilities]
    }));
  }

  public getToolRegistration(name: string): ToolRegistrationDescriptor | undefined {
    const registration = this.toolRegistrations.get(name);
    return registration ? { ...registration, capabilities: [...registration.capabilities] } : undefined;
  }

  // -------------------------------------------------------------
  // 斜杠指令 (Slash Commands)
  // -------------------------------------------------------------
  public registerCommand(nameOrConfig: string | CommandDefinition | any, handler?: CommandHandler): () => void {
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

    const token = Symbol();
    this.registrationTokens.commands.set(cleanName, token);
    return () => {
      if (this.registrationTokens.commands.get(cleanName) === token) this.unregisterCommand(cleanName);
    };
  }

  public unregisterCommand(name: string): boolean {
    const cleanName = name.startsWith('/') ? name.slice(1) : name;
    this.registrationTokens.commands.delete(cleanName);
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
    keyOrConfig:
      | string
      | { key: string; execute?: () => boolean | Promise<boolean>; handler?: ShortcutHandler; description?: string },
    handler?: ShortcutHandler
  ): () => void {
    const key = typeof keyOrConfig === 'string' ? keyOrConfig : keyOrConfig.key;
    const fn = typeof keyOrConfig === 'string' ? handler! : keyOrConfig.handler || (() => {});
    const shortcutObj = {
      key,
      handler: fn,
      execute:
        typeof keyOrConfig === 'object' && keyOrConfig.execute
          ? keyOrConfig.execute
          : async () => {
              if (typeof fn === 'function') {
                await (fn as any)();
              } else if (fn && typeof (fn as any).execute === 'function') {
                await (fn as any).execute();
              }
              return true;
            }
    };
    this.shortcuts.set(key, shortcutObj);
    const token = Symbol();
    this.registrationTokens.shortcuts.set(key, token);
    return () => {
      if (this.registrationTokens.shortcuts.get(key) === token) this.unregisterShortcut(key);
    };
  }

  public unregisterShortcut(key: string): boolean {
    this.registrationTokens.shortcuts.delete(key);
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
    for (const tf of [...this.transformers]) {
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

  public registerToolHooks(hooks: ToolHooks): () => void {
    this.toolHooks.push(hooks);
    return () => {
      const idx = this.toolHooks.indexOf(hooks);
      if (idx !== -1) this.toolHooks.splice(idx, 1);
    };
  }

  public async executeBeforeToolCall(
    event: import('@inkpi/protocol').ToolExecutionEvent
  ): Promise<import('@inkpi/protocol').BeforeToolHookResult> {
    let currentParams = { ...event.parameters };
    for (const h of [...this.toolHooks]) {
      if (h.beforeToolCall) {
        const res = await h.beforeToolCall({ ...event, parameters: currentParams });
        if (res?.block) {
          return { block: true, reason: res.reason, terminate: res.terminate };
        }
        if (res?.modifiedParams) {
          currentParams = res.modifiedParams;
        }
      }
    }
    return { block: false, modifiedParams: currentParams };
  }

  public async executeAfterToolCall(
    event: import('@inkpi/protocol').ToolExecutionResultEvent
  ): Promise<import('@inkpi/protocol').AfterToolHookResult | undefined> {
    const currentResult = { ...event.result };
    let overridden = false;
    let terminate = false;
    for (const h of [...this.toolHooks]) {
      if (h.afterToolCall) {
        const res = await h.afterToolCall({ ...event, result: currentResult });
        if (res) {
          overridden = true;
          if (res.content) currentResult.content = res.content;
          if (res.details !== undefined) currentResult.details = res.details;
          if (res.isError !== undefined) currentResult.isError = res.isError;
          if (res.terminate) terminate = true;
        }
      }
    }
    return overridden ? { ...currentResult, terminate } : undefined;
  }

  public getPipelineHooks(): PipelineHooks[] {
    return [...this.pipelineHooks];
  }

  public clear(): void {
    for (const invalidate of [...this.generationInvalidators]) invalidate();
    this.generationInvalidators.clear();
    this.listeners.clear();
    this.commands.clear();
    this.shortcuts.clear();
    this.tools.clear();
    this.toolRegistrations.clear();
    this.transformers = [];
    this.pipelineHooks = [];
    this.toolHooks = [];
    this.registrationTokens.tools.clear();
    this.registrationTokens.commands.clear();
    this.registrationTokens.shortcuts.clear();
  }

  /** @internal All validation precedes the synchronous registry cutover. */
  public mountGeneration(stage: ExtensionHost, previous?: ExtensionMount): ExtensionMount {
    const check = (kind: 'tools' | 'commands' | 'shortcuts', current: Map<string, any>, next: Map<string, any>) => {
      for (const name of next.keys()) {
        if (current.has(name) && !previous?.owns(kind, name)) {
          throw new Error(`Extension registration '${name}' belongs to another owner.`);
        }
      }
    };
    check('tools', this.tools, stage.tools);
    check('commands', this.commands, stage.commands);
    check('shortcuts', this.shortcuts, stage.shortcuts);
    const tools = new Map(stage.tools);
    const commands = new Map(stage.commands);
    const shortcuts = new Map(stage.shortcuts);
    const listeners = [...stage.listeners].flatMap(([event, list]) => list.map((listener) => ({ event, listener })));
    const transformers = [...stage.transformers];
    const pipelineHooks = [...stage.pipelineHooks];
    const toolHooks = [...stage.toolHooks];
    const tokens = {
      tools: new Map<string, symbol>(),
      commands: new Map<string, symbol>(),
      shortcuts: new Map<string, symbol>()
    };
    previous?.dispose();
    for (const [name, tool] of tools) {
      this.tools.set(name, tool);
      this.toolRegistrations.set(name, stage.toolRegistrations.get(name)!);
    }
    for (const [name, command] of commands) this.commands.set(name, command);
    for (const [name, shortcut] of shortcuts) this.shortcuts.set(name, shortcut);
    for (const kind of ['tools', 'commands', 'shortcuts'] as const) {
      for (const name of stage[kind].keys()) {
        const token = Symbol();
        tokens[kind].set(name, token);
        this.registrationTokens[kind].set(name, token);
      }
    }
    for (const { event, listener } of listeners) {
      const list = this.listeners.get(event) ?? [];
      list.push(listener);
      this.listeners.set(event, list);
    }
    this.transformers.push(...transformers);
    this.pipelineHooks.push(...pipelineHooks);
    this.toolHooks.push(...toolHooks);
    const owns = (kind: 'tools' | 'commands' | 'shortcuts', name: string) =>
      tokens[kind].has(name) && this.registrationTokens[kind].get(name) === tokens[kind].get(name);
    return {
      tools,
      commands,
      shortcuts,
      owns,
      dispose: () => {
        for (const name of tools.keys()) if (owns('tools', name)) this.unregisterTool(name);
        for (const name of commands.keys()) if (owns('commands', name)) this.unregisterCommand(name);
        for (const name of shortcuts.keys()) if (owns('shortcuts', name)) this.unregisterShortcut(name);
        for (const { event, listener } of listeners) this.off(event, listener);
        this.transformers = this.transformers.filter((entry) => !transformers.includes(entry));
        this.pipelineHooks = this.pipelineHooks.filter((entry) => !pipelineHooks.includes(entry));
        this.toolHooks = this.toolHooks.filter((entry) => !toolHooks.includes(entry));
      }
    };
  }

  /** @internal Clearing a host must also fence references retained by old modules. */
  public registerGenerationInvalidator(invalidate: () => void): () => void {
    this.generationInvalidators.add(invalidate);
    return () => {
      this.generationInvalidators.delete(invalidate);
    };
  }

  /** @internal No live registration changes until the complete group passes preflight. */
  public mountGenerationBatch(stages: readonly ExtensionHost[], previous: readonly ExtensionMount[]): ExtensionMount[] {
    for (const kind of ['tools', 'commands', 'shortcuts'] as const) {
      const seen = new Set<string>();
      for (const stage of stages)
        for (const name of stage[kind].keys()) {
          if (seen.has(name)) throw new Error(`Duplicate extension registration '${name}' in replacement group.`);
          seen.add(name);
          if (this[kind].has(name) && !previous.some((mount) => mount.owns(kind, name)))
            throw new Error(`Extension registration '${name}' belongs to another owner.`);
        }
    }
    for (const mount of previous) mount.dispose();
    return stages.map((stage) => this.mountGeneration(stage));
  }
}

export class ExtensionRunner {
  private host: ExtensionHost;
  private loadedModules = new Map<string, ExtensionModule>();
  private generations = new Map<string, ExtensionGeneration>();
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private nextGeneration = 1;

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
    return this.serialize(async () => {
      let generation: ExtensionGeneration | undefined;
      try {
        const module: ExtensionModule = normalizeExtensionModule(ext, name);
        if (!module.name.trim()) throw new Error('Extension name must not be empty.');
        validateExtensionDependencies(new Map([...this.liveModules(), [module.name, module]]));
        generation = new ExtensionGeneration(this.host, new ExtensionHost(), this.nextGeneration++);
        if (module.dispose) generation.api.onDispose(module.dispose);
        await module.factory(generation.api);
        const previous = this.generations.get(module.name);
        generation.commit(previous);
        this.generations.set(module.name, generation);
        this.loadedModules.set(module.name, module);
        if (previous) await this.cleanup(previous);
        return true;
      } catch (err) {
        if (generation) await this.cleanup(generation);
        consoleLogger.error('[ExtensionRunner] Failed to load extension:', err);
        return false;
      }
    });
  }

  public async loadAll(extensions: ExtensionModule[]): Promise<void> {
    return this.serialize(async () => {
      const combined = this.liveModules();
      const seen = new Set<string>();
      for (const input of extensions) {
        const module = normalizeExtensionModule(input);
        if (seen.has(module.name)) throw new Error(`Duplicate extension '${module.name}'.`);
        seen.add(module.name);
        combined.set(module.name, module);
      }
      const order = validateExtensionDependencies(combined).filter((module) => seen.has(module.name));
      const prepared: Array<{
        module: ExtensionModule;
        generation: ExtensionGeneration;
        previous?: ExtensionGeneration;
      }> = [];
      try {
        for (const module of order) {
          const generation = new ExtensionGeneration(this.host, new ExtensionHost(), this.nextGeneration++);
          prepared.push({ module, generation, previous: this.generations.get(module.name) });
          if (module.dispose) generation.api.onDispose(module.dispose);
          await module.factory(generation.api);
        }
        for (const entry of prepared) entry.generation.assertPreparing();
        const mounts = this.host.mountGenerationBatch(
          prepared.map((entry) => entry.generation.getStage()),
          prepared.flatMap((entry) => (entry.previous?.getMount() ? [entry.previous.getMount()!] : []))
        );
        for (let index = 0; index < prepared.length; index++) {
          const entry = prepared[index];
          entry.generation.adopt(mounts[index]);
          this.generations.set(entry.module.name, entry.generation);
          this.loadedModules.set(entry.module.name, entry.module);
        }
        for (const entry of prepared) entry.previous?.invalidate();
      } catch (error) {
        for (const entry of [...prepared].reverse()) await this.cleanup(entry.generation);
        throw error;
      }
      for (const entry of [...prepared].reverse()) if (entry.previous) await this.cleanup(entry.previous);
    });
  }

  public async unloadExtension(name: string): Promise<void> {
    return this.serialize(async () => {
      const dependent = [...this.liveModules().values()].find((module) => module.dependencies?.includes(name));
      if (dependent) throw new Error(`Extension '${name}' is required by '${dependent.name}'.`);
      const generation = this.generations.get(name);
      this.generations.delete(name);
      this.loadedModules.delete(name);
      if (generation) await generation.dispose();
    });
  }

  public async dispose(): Promise<void> {
    return this.serialize(async () => {
      const errors: unknown[] = [];
      for (const module of validateExtensionDependencies(this.loadedModules).reverse()) {
        const generation = this.generations.get(module.name);
        this.generations.delete(module.name);
        this.loadedModules.delete(module.name);
        try {
          await generation?.dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Extension disposal failed.');
    });
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.mutationQueue.catch(() => undefined).then(operation);
    this.mutationQueue = pending.then(
      () => undefined,
      () => undefined
    );
    return pending;
  }

  private async cleanup(generation: ExtensionGeneration): Promise<void> {
    try {
      await generation.dispose();
    } catch (error) {
      consoleLogger.error('[ExtensionRunner] Cleanup failed:', error);
    }
  }

  public getLoadedModules(): ExtensionModule[] {
    return Array.from(this.liveModules().values()).map((module) => ({
      ...module,
      ...(module.dependencies ? { dependencies: [...module.dependencies] } : {})
    }));
  }

  private liveModules(): Map<string, ExtensionModule> {
    return new Map([...this.loadedModules].filter(([name]) => this.generations.get(name)?.isActive()));
  }

  /** @deprecated 名实不符（返回的是模块而非文档），已由 getLoadedModules 取代。 */
  public getLoadedExtensions(): ExtensionModule[] {
    return this.getLoadedModules();
  }
}

function normalizeExtensionModule(ext: any, name?: string): ExtensionModule {
  const factory = typeof ext === 'function' ? ext : (ext?.factory ?? ext?.init);
  if (typeof factory !== 'function') throw new Error('Extension requires a factory function.');
  const moduleName = name ?? (typeof ext === 'object' ? ext.name : undefined) ?? 'anonymous-extension';
  if (typeof moduleName !== 'string' || !moduleName.trim()) throw new Error('Extension name must not be empty.');
  if (ext?.dependencies !== undefined && !Array.isArray(ext.dependencies))
    throw new Error('Extension dependencies must be an array.');
  return {
    ...(typeof ext === 'object' ? ext : {}),
    name: moduleName,
    factory,
    ...(ext?.dependencies === undefined ? {} : { dependencies: [...ext.dependencies] })
  };
}

function validateExtensionDependencies(modules: ReadonlyMap<string, ExtensionModule>): ExtensionModule[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: ExtensionModule[] = [];
  const visit = (name: string) => {
    if (visited.has(name)) return;
    if (visiting.has(name)) throw new Error(`Cyclic extension dependency '${name}'.`);
    const module = modules.get(name);
    if (!module) throw new Error(`Missing extension dependency '${name}'.`);
    if (
      !name.trim() ||
      typeof module.factory !== 'function' ||
      (module.dispose !== undefined && typeof module.dispose !== 'function')
    )
      throw new Error('Invalid extension module.');
    if (
      module.dependencies !== undefined &&
      (!Array.isArray(module.dependencies) ||
        module.dependencies.some((dependency) => typeof dependency !== 'string' || !dependency.trim()))
    )
      throw new Error(`Invalid dependencies for extension '${name}'.`);
    visiting.add(name);
    for (const dependency of module.dependencies ?? []) visit(dependency);
    visiting.delete(name);
    visited.add(name);
    ordered.push(module);
  };
  for (const name of modules.keys()) visit(name);
  return ordered;
}
