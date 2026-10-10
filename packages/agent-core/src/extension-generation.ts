import type { AgentTool, ExtensionAPI } from '@inkpi/protocol';
import type { ExtensionHost, ExtensionMount } from './extension-host.js';

export interface ExtensionGenerationAPI extends ExtensionAPI {
  readonly generation: number;
  readonly signal: AbortSignal;
  onDispose(callback: () => void | Promise<void>): void;
}

/** A scoped facade whose registrations become visible only after preparation. */
export class ExtensionGeneration {
  readonly api: ExtensionGenerationAPI;
  private phase: 'preparing' | 'active' | 'disposed' = 'preparing';
  private readonly controller = new AbortController();
  private readonly cleanup: Array<() => void | Promise<void>> = [];
  private mount?: ExtensionMount;
  private removeInvalidator?: () => void;
  private cleanupPromise?: Promise<void>;

  constructor(
    private readonly host: ExtensionHost,
    private readonly stage: ExtensionHost,
    readonly generation: number
  ) {
    this.api = new Proxy({} as ExtensionGenerationAPI, {
      get: (_target, property) => this.member(property),
      set: () => false
    });
    this.removeInvalidator = this.host.registerGenerationInvalidator(() => this.invalidate());
  }

  private assertLive(requireActive = false): void {
    if (this.phase === 'disposed' || (requireActive && this.phase !== 'active'))
      throw new Error('Extension generation is inactive.');
  }

  private guard(callback: (...args: any[]) => any): (...args: any[]) => Promise<any> {
    return async (...args) => {
      this.assertLive(true);
      const result = await callback(...args);
      this.assertLive(true);
      return result;
    };
  }

  private tool(tool: AgentTool): AgentTool {
    const execute = this.guard(async (id, args, signal, onUpdate, context) => {
      const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal;
      return tool.execute(
        id,
        args,
        combined,
        (update, options) => {
          if (this.phase === 'active') onUpdate?.(update, options);
        },
        context
      );
    });
    return {
      ...tool,
      ...(tool.parameters === undefined ? {} : { parameters: structuredClone(tool.parameters) }),
      execute
    };
  }

  private callbacks(value: Record<string, any>): Record<string, any> {
    const wrapped = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, typeof entry === 'function' ? this.guard(entry) : entry])
    );
    for (const key of [
      'execute',
      'handler',
      'onBeforeStage',
      'onAfterStage',
      'onStageOutput',
      'beforeToolCall',
      'afterToolCall'
    ]) {
      if (typeof value[key] === 'function') wrapped[key] = this.guard(value[key].bind(value));
    }
    return wrapped;
  }

  private register(method: string, args: any[]): () => void {
    this.assertLive();
    if (this.phase === 'active') this.checkOwner(method, args);
    const previousStage = this.stage;
    const dispose = Reflect.apply((previousStage as any)[method], previousStage, args) as () => void;
    try {
      if (this.phase === 'active') this.mount = this.host.mountGeneration(this.stage, this.mount);
    } catch (error) {
      dispose();
      throw error;
    }
    return () => {
      dispose();
      if (this.phase === 'active') this.mount = this.host.mountGeneration(this.stage, this.mount);
    };
  }

  private checkOwner(method: string, args: any[]): void {
    const kind =
      method === 'registerTool'
        ? 'tools'
        : method === 'registerCommand'
          ? 'commands'
          : method === 'registerShortcut'
            ? 'shortcuts'
            : undefined;
    if (!kind) return;
    const input = args[0];
    const rawName = typeof input === 'string' ? input : kind === 'shortcuts' ? input.key : input.name;
    const name = kind === 'commands' ? rawName.replace(/^\//, '') : rawName;
    const current =
      kind === 'tools'
        ? this.host.getTools().some((tool) => tool.name === name)
        : kind === 'commands'
          ? Boolean(this.host.getCommand(name))
          : this.host.getShortcuts().some((shortcut) => shortcut.key === name);
    if (current && !this.mount?.owns(kind, name))
      throw new Error(`Extension registration '${name}' belongs to another owner.`);
  }

  private member(property: string | symbol): any {
    if (property === 'generation') return this.generation;
    if (property === 'signal') return this.controller.signal;
    if (property === 'onDispose')
      return (callback: () => void | Promise<void>) => {
        this.assertLive();
        if (typeof callback !== 'function') throw new Error('Extension cleanup requires a callback.');
        this.cleanup.push(callback);
      };
    if (property === 'registerTool')
      return (tool: AgentTool, options?: unknown) => this.register('registerTool', [this.tool(tool), options]);
    if (property === 'on')
      return (event: string, callback: (...args: any[]) => any) => this.register('on', [event, this.guard(callback)]);
    if (property === 'addContextTransformer')
      return (callback: (...args: any[]) => any) => this.register('addContextTransformer', [this.guard(callback)]);
    if (property === 'registerPipelineHooks' || property === 'registerToolHooks')
      return (hooks: Record<string, any>) => this.register(property, [this.callbacks(hooks)]);
    if (property === 'registerCommand')
      return (command: any, handler?: any) =>
        typeof command === 'string'
          ? this.register('registerCommand', [command, this.guard(handler)])
          : this.register('registerCommand', [this.callbacks(command)]);
    if (property === 'registerShortcut')
      return (shortcut: any, handler?: any) =>
        typeof shortcut === 'string'
          ? this.register('registerShortcut', [shortcut, this.guard(handler)])
          : this.register('registerShortcut', [this.callbacks(shortcut)]);
    const unregister = { unregisterTool: 'name', unregisterCommand: 'name', unregisterShortcut: 'key' } as const;
    if (typeof property === 'string' && Object.hasOwn(unregister, property))
      return (name: string) => {
        if (this.phase === 'disposed') return false;
        const result = (this.stage as any)[property](name);
        if (this.phase === 'active') this.mount = this.host.mountGeneration(this.stage, this.mount);
        return result;
      };
    if (property === 'getTools' || property === 'getCommands' || property === 'getShortcuts')
      return () => {
        this.assertLive();
        const own = this.stage[property]();
        const key = property === 'getShortcuts' ? 'key' : 'name';
        return [...this.host[property]().filter((entry) => !own.some((value) => value[key] === entry[key])), ...own];
      };
    if (property === 'getPipelineHooks')
      return () => {
        this.assertLive();
        return this.phase === 'active' ? this.host.getPipelineHooks() : this.stage.getPipelineHooks();
      };
    if (['emit', 'transformContext', 'showSelectList', 'showInput', 'flashNotification'].includes(String(property)))
      return (...args: unknown[]) => {
        this.assertLive(true);
        return Reflect.apply((this.host as any)[property], this.host, args);
      };
    return undefined;
  }

  commit(previous?: ExtensionGeneration): void {
    this.assertPreparing();
    const mount = this.host.mountGeneration(this.stage, previous?.mount);
    this.adopt(mount);
    previous?.invalidate();
  }

  /** @internal Batch cutover adopts every new generation before aborting old callbacks. */
  assertPreparing(): void {
    this.assertLive();
    if (this.phase !== 'preparing') throw new Error('Extension generation has already been committed.');
  }

  adopt(mount: ExtensionMount): void {
    this.assertLive();
    this.mount = mount;
    this.phase = 'active';
  }
  getStage(): ExtensionHost {
    return this.stage;
  }
  getMount(): ExtensionMount | undefined {
    return this.mount;
  }

  isActive(): boolean {
    return this.phase === 'active';
  }

  invalidate(): void {
    this.phase = 'disposed';
    this.controller.abort(new Error('Extension generation retired.'));
    this.removeInvalidator?.();
  }

  dispose(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.invalidate();
    this.mount?.dispose();
    this.cleanupPromise = (async () => {
      const errors: unknown[] = [];
      for (const cleanup of [...this.cleanup].reverse()) {
        try {
          await cleanup();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, 'Extension generation cleanup failed.');
    })();
    return this.cleanupPromise;
  }
}
