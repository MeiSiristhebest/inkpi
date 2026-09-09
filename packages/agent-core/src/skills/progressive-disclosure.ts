import type {
  AgentTool,
  ContextTransformer,
  ExtensionAPI,
  SkillInfo,
  ToolRegistrationDescriptor,
  ToolRegistrationOptions
} from '@inkpi/protocol';
import type { ContextPipeline } from '../context/index.js';
import type { ContextProvider } from '../context/types.js';
import { ExtensionHost } from '../extension-host.js';
import { type DynamicLoadSummary, DynamicPluginLoader } from '../package-manager/dynamic-loader.js';
import type { TaskHandler } from '../tasks/task-handler.js';
import type { TaskRegistry } from '../tasks/task-registry.js';
import { ToolRegistry } from '../tools.js';
import { SkillDiscoveryEngine } from './skills.js';

export interface SkillManifestEntry {
  name: string;
  description: string;
  loaded: boolean;
}

export type SkillActivation = 'eager' | 'lazy' | 'on-demand';

export interface SkillManifest {
  id: string;
  version: string;
  title: string;
  description: string;
  intents?: string[];
  capabilities?: string[];
  taskKinds?: string[];
  tools?: string[];
  activation: SkillActivation;
}

/**
 * Serializable registration view for a Desktop/Daemon handshake.
 * Skill prompt bodies and tool executors deliberately stay process-local.
 */
export interface SkillRuntimeRegistrationSnapshot {
  skills: SkillManifest[];
  activatedSkills: string[];
  tools: ToolRegistrationDescriptor[];
}

export interface ProgressiveSkillRuntimeOptions {
  searchDirs?: string[];
  extensionHost?: ExtensionHost;
  toolRegistry?: ToolRegistry;
  taskRegistry?: TaskRegistry;
  contextPipeline?: ContextPipeline;
  discovery?: SkillDiscoveryEngine;
  activationAdapter?: LazySkillActivationAdapter;
  skillActivators?: ReadonlyMap<string, SkillActivationSource> | Readonly<Record<string, SkillActivationSource>>;
}

export interface SkillResolveQuery {
  intent?: string;
  capability?: string;
  taskKind?: string;
  activation?: SkillActivation;
}

type SkillRegistrationItems<T> = T | readonly T[];

/** Resources a loaded skill may attach to the existing runtime registries. */
export interface SkillRegistration {
  task?: SkillRegistrationItems<TaskHandler>;
  tasks?: SkillRegistrationItems<TaskHandler>;
  tool?: SkillRegistrationItems<AgentTool>;
  tools?: SkillRegistrationItems<AgentTool>;
  context?: SkillRegistrationItems<ContextProvider>;
  contexts?: SkillRegistrationItems<ContextProvider>;
  contextProvider?: SkillRegistrationItems<ContextProvider>;
  contextProviders?: SkillRegistrationItems<ContextProvider>;
  contextTransformer?: SkillRegistrationItems<ContextTransformer>;
  contextTransformers?: SkillRegistrationItems<ContextTransformer>;
}

export interface SkillActivationContext extends ExtensionAPI {
  readonly skill: SkillInfo;
  /** A scoped facade over the existing ExtensionHost for rollback on failure. */
  readonly api: ExtensionAPI;
  /** The actual shared host used by DynamicPluginLoader and Agent. */
  readonly extensionHost: ExtensionHost;
  /** The actual shared tool registry used by Agent/TaskRouter callers. */
  readonly toolRegistry: ToolRegistry;
  readonly taskRegistry?: TaskRegistry;
  readonly contextPipeline?: ContextPipeline;
  registerTask(handler: TaskHandler): void;
  registerTool(tool: AgentTool): void;
  registerContext(provider: ContextProvider): void;
  registerContextTransformer(transformer: ContextTransformer): () => void;
  register(registration: SkillRegistration): void;
}

// biome-ignore lint/suspicious/noConfusingVoidType: Imperative activators may intentionally return nothing.
type SkillActivationResult = SkillRegistration | void;

export type SkillActivator = (
  context: SkillActivationContext
) => SkillActivationResult | Promise<SkillActivationResult>;

export type SkillActivationSource = SkillActivator | SkillRegistration;

export interface SkillActivationAdapterOptions {
  extensionHost: ExtensionHost;
  toolRegistry: ToolRegistry;
  taskRegistry?: TaskRegistry;
  contextPipeline?: ContextPipeline;
}

type UndoAction = () => void;

/**
 * Small lifecycle bridge for one loaded skill.
 *
 * It deliberately owns no plugin discovery or execution model. Activation
 * callbacks receive the existing ExtensionHost and registries, and a failed
 * activation is rolled back so a later call can retry it safely.
 */
export class LazySkillActivationAdapter {
  readonly extensionHost: ExtensionHost;
  readonly toolRegistry: ToolRegistry;
  readonly taskRegistry?: TaskRegistry;
  readonly contextPipeline?: ContextPipeline;

  private readonly activated = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(options: SkillActivationAdapterOptions) {
    this.extensionHost = options.extensionHost;
    this.toolRegistry = options.toolRegistry;
    this.taskRegistry = options.taskRegistry;
    this.contextPipeline = options.contextPipeline;
  }

  public async activate(skill: SkillInfo, source?: SkillActivationSource): Promise<void> {
    if (this.activated.has(skill.name)) return;

    const pending = this.pending.get(skill.name);
    if (pending) return pending;

    const activation = Promise.resolve().then(async () => {
      const undo: UndoAction[] = [];
      try {
        const context = this.createContext(skill, undo);
        const registration = typeof source === 'function' ? await source(context) : source;
        this.applyRegistration(skill, registration, undo);
        this.activated.add(skill.name);
      } catch (error) {
        this.rollback(undo);
        throw error;
      }
    });

    this.pending.set(skill.name, activation);
    void activation.then(
      () => this.clearPending(skill.name, activation),
      () => this.clearPending(skill.name, activation)
    );
    return activation;
  }

  public isActivated(skillName: string): boolean {
    return this.activated.has(skillName);
  }

  public listActivated(): string[] {
    return [...this.activated].sort();
  }

  private clearPending(skillName: string, activation: Promise<void>): void {
    if (this.pending.get(skillName) === activation) this.pending.delete(skillName);
  }

  private createContext(skill: SkillInfo, undo: UndoAction[]): SkillActivationContext {
    const context = {
      skill,
      api: this.createScopedApi(skill, undo),
      extensionHost: this.extensionHost,
      toolRegistry: this.toolRegistry,
      taskRegistry: this.taskRegistry,
      contextPipeline: this.contextPipeline,
      registerTask: (handler: TaskHandler) => this.registerTask(skill.name, handler, undo),
      registerTool: (tool: AgentTool) => this.registerTool(tool, undo, skill),
      registerContext: (provider: ContextProvider) => this.registerContext(skill.name, provider, undo),
      registerContextTransformer: (transformer: ContextTransformer) =>
        this.registerContextTransformer(transformer, undo),
      register: (registration: SkillRegistration) => this.applyRegistration(skill, registration, undo)
    };
    const api = context.api;

    return new Proxy(context, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        return Reflect.get(api, property, api);
      }
    }) as SkillActivationContext;
  }

  private createScopedApi(skill: SkillInfo, undo: UndoAction[]): ExtensionAPI {
    const adapter = this;
    return new Proxy(this.extensionHost, {
      get(target, property, receiver) {
        if (property === 'registerTool') {
          return (tool: AgentTool) => adapter.registerTool(tool, undo, skill);
        }
        if (property === 'addContextTransformer') {
          return (transformer: ContextTransformer) => adapter.registerContextTransformer(transformer, undo);
        }

        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;

        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          if (typeof result === 'function') undo.push(result as UndoAction);
          return result;
        };
      }
    }) as ExtensionAPI;
  }

  private applyRegistration(skill: SkillInfo, registration: SkillActivationResult, undo: UndoAction[]): void {
    if (!registration) return;

    for (const task of asItems(registration.tasks ?? registration.task)) {
      this.registerTask(skill.name, task, undo);
    }
    for (const tool of asItems(registration.tools ?? registration.tool)) {
      this.registerTool(tool, undo, skill);
    }
    for (const provider of asItems(
      registration.contexts ?? registration.contextProviders ?? registration.contextProvider ?? registration.context
    )) {
      this.registerContext(skill.name, provider, undo);
    }
    for (const transformer of asItems(registration.contextTransformers ?? registration.contextTransformer)) {
      this.registerContextTransformer(transformer, undo);
    }
  }

  private registerTask(skillName: string, handler: TaskHandler, undo: UndoAction[]): void {
    if (!this.taskRegistry) {
      throw new Error(`Skill '${skillName}' cannot register a task without a TaskRegistry`);
    }

    const existing = this.taskRegistry.list().find((candidate) => candidate.id === handler.id);
    if (existing === handler) return;

    this.taskRegistry.register(handler);
    undo.push(() => this.taskRegistry?.unregister(handler.id));
  }

  private registerTool(tool: AgentTool, undo: UndoAction[], skill?: SkillInfo): void {
    const existingHostTool = this.extensionHost.getTools().find((candidate) => candidate?.name === tool.name);
    const existingHostRegistration = this.extensionHost.getToolRegistration(tool.name);
    const existingRegistryTool = this.toolRegistry.get(tool.name);
    const existingRegistryRegistration = this.toolRegistry.getRegistration(tool.name);
    const hostChanged = existingHostTool !== tool;
    const registryChanged = existingRegistryTool !== tool;
    const registration = skill ? toolRegistrationOptions(skill) : undefined;

    if (!hostChanged && !registryChanged) return;

    if (hostChanged) this.extensionHost.registerTool(tool, registration);
    try {
      if (registryChanged) this.toolRegistry.register(tool, registration);
    } catch (error) {
      this.restoreHostTool(tool.name, existingHostTool, existingHostRegistration);
      throw error;
    }

    undo.push(() => {
      if (registryChanged) {
        this.restoreRegistryTool(tool.name, existingRegistryTool, existingRegistryRegistration);
      }
      if (hostChanged) this.restoreHostTool(tool.name, existingHostTool, existingHostRegistration);
    });
  }

  private registerContext(skillName: string, provider: ContextProvider, undo: UndoAction[]): void {
    if (!this.contextPipeline) {
      throw new Error(`Skill '${skillName}' cannot register context without a ContextPipeline`);
    }

    const existing = this.contextPipeline.list().find((candidate) => candidate.id === provider.id);
    if (existing === provider) return;

    this.contextPipeline.register(provider);
    undo.push(() => this.contextPipeline?.unregister(provider.id));
  }

  private registerContextTransformer(transformer: ContextTransformer, undo: UndoAction[]): () => void {
    const dispose = this.extensionHost.addContextTransformer(transformer);
    let disposed = false;
    const unregister = () => {
      if (disposed) return;
      disposed = true;
      dispose();
    };
    undo.push(unregister);
    return unregister;
  }

  private restoreHostTool(name: string, tool: any, registration?: ToolRegistrationDescriptor): void {
    if (tool === undefined) this.extensionHost.unregisterTool(name);
    else this.extensionHost.registerTool(tool, toToolRegistrationOptions(registration));
  }

  private restoreRegistryTool(
    name: string,
    tool: AgentTool | undefined,
    registration?: ToolRegistrationDescriptor
  ): void {
    if (tool === undefined) this.toolRegistry.unregister(name);
    else this.toolRegistry.register(tool, toToolRegistrationOptions(registration));
  }

  private rollback(undo: UndoAction[]): void {
    for (let index = undo.length - 1; index >= 0; index -= 1) {
      try {
        undo[index]();
      } catch {
        // Preserve the activation failure; cleanup is best effort.
      }
    }
  }
}

/** Backward-compatible concise name for callers that do not need the lazy qualifier. */
export { LazySkillActivationAdapter as SkillActivationAdapter };

/**
 * Keeps skill discovery cheap and loads full prompt bodies only on demand.
 * Dynamic extensions continue to use the existing ExtensionHost and loader;
 * tools are mirrored into the existing ToolRegistry after activation.
 */
export class ProgressiveSkillRuntime {
  readonly extensionHost: ExtensionHost;
  readonly toolRegistry: ToolRegistry;
  readonly taskRegistry?: TaskRegistry;
  readonly contextPipeline?: ContextPipeline;
  readonly pluginLoader: DynamicPluginLoader;
  readonly activationAdapter: LazySkillActivationAdapter;
  private readonly discovery: SkillDiscoveryEngine;
  private readonly skills = new Map<string, SkillInfo>();
  private readonly loaded = new Set<string>();
  private readonly skillActivators = new Map<string, SkillActivationSource>();
  private readonly pendingActivations = new Map<string, Promise<SkillInfo>>();

  constructor(options: ProgressiveSkillRuntimeOptions = {}) {
    const activationAdapter = options.activationAdapter;
    this.extensionHost = options.extensionHost ?? activationAdapter?.extensionHost ?? new ExtensionHost();
    this.toolRegistry = options.toolRegistry ?? activationAdapter?.toolRegistry ?? new ToolRegistry();
    this.taskRegistry = options.taskRegistry ?? activationAdapter?.taskRegistry;
    this.contextPipeline = options.contextPipeline ?? activationAdapter?.contextPipeline;
    this.pluginLoader = new DynamicPluginLoader(this.extensionHost);
    this.activationAdapter =
      activationAdapter ??
      new LazySkillActivationAdapter({
        extensionHost: this.extensionHost,
        toolRegistry: this.toolRegistry,
        taskRegistry: this.taskRegistry,
        contextPipeline: this.contextPipeline
      });
    this.discovery = options.discovery ?? new SkillDiscoveryEngine(options.searchDirs ?? []);
    addSkillActivators(this.skillActivators, options.skillActivators);
  }

  discover(): SkillManifestEntry[] {
    for (const skill of this.discovery.discover()) {
      // Keep an already loaded body in memory while refreshing metadata from
      // disk. A second metadata scan must not trigger another body load.
      if (!this.loaded.has(skill.name)) this.skills.set(skill.name, skill);
    }
    return [...this.skills.values()]
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        loaded: this.loaded.has(skill.name)
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  discoverManifests(): SkillManifest[] {
    if (this.skills.size === 0) this.discover();
    return [...this.skills.values()].map(toManifest).sort((left, right) => left.id.localeCompare(right.id));
  }

  resolve(query: SkillResolveQuery): SkillManifest[] {
    return this.discoverManifests().filter(
      (manifest) =>
        (!query.intent || manifest.intents?.includes(query.intent)) &&
        (!query.capability || manifest.capabilities?.includes(query.capability)) &&
        (!query.taskKind || manifest.taskKinds?.includes(query.taskKind)) &&
        (!query.activation || manifest.activation === query.activation)
    );
  }

  registerSkill(skill: SkillInfo, source?: SkillActivationSource): void {
    this.skills.set(skill.name, skill);
    if (source !== undefined) this.skillActivators.set(skill.name, source);
  }

  registerSkillActivator(name: string, source: SkillActivationSource): void {
    this.skillActivators.set(name, source);
  }

  listLoaded(): string[] {
    return [...this.loaded].sort();
  }

  listActivated(): string[] {
    return this.activationAdapter.listActivated();
  }

  /** Return only process-safe skill and tool metadata for a future RPC adapter. */
  getRegistrationSnapshot(): SkillRuntimeRegistrationSnapshot {
    return {
      skills: this.discoverManifests().map(cloneManifest),
      activatedSkills: this.listActivated(),
      tools: this.toolRegistry.getRegistrations()
    };
  }

  load(name: string): SkillInfo {
    const skill = this.discovery.loadSkill(name) || this.skills.get(name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    this.skills.set(name, skill);
    this.loaded.add(name);
    return { ...skill, frontmatter: { ...skill.frontmatter } };
  }

  async activate(name: string, source?: SkillActivationSource): Promise<SkillInfo> {
    if (this.activationAdapter.isActivated(name)) {
      const skill = this.skills.get(name) ?? this.discovery.getSkill(name);
      if (!skill) throw new Error(`Skill not found: ${name}`);
      return cloneSkill(skill);
    }

    const pending = this.pendingActivations.get(name);
    if (pending) return pending;

    const activation = Promise.resolve().then(async () => {
      const skill = this.load(name);
      const registeredSource = source ?? this.skillActivators.get(name) ?? readSkillActivation(skill);
      await this.activationAdapter.activate(skill, registeredSource);
      return cloneSkill(skill);
    });

    this.pendingActivations.set(name, activation);
    void activation.then(
      () => this.clearPendingActivation(name, activation),
      () => this.clearPendingActivation(name, activation)
    );
    return activation;
  }

  async loadAndActivate(name: string, source?: SkillActivationSource): Promise<SkillInfo> {
    return this.activate(name, source);
  }

  async loadExtensions(directory: string): Promise<DynamicLoadSummary> {
    const summary = await this.pluginLoader.loadFromDirectory(directory);
    for (const tool of this.extensionHost.getTools()) {
      if (!this.toolRegistry.get(tool.name)) {
        this.toolRegistry.register(tool, this.extensionHost.getToolRegistration(tool.name));
      }
    }
    return summary;
  }

  getExtensionApi(): ExtensionAPI {
    return this.extensionHost;
  }

  private clearPendingActivation(name: string, activation: Promise<SkillInfo>): void {
    if (this.pendingActivations.get(name) === activation) this.pendingActivations.delete(name);
  }
}

function toolRegistrationOptions(skill: SkillInfo): ToolRegistrationOptions {
  const manifest = toManifest(skill);
  return {
    source: 'skill',
    skillId: manifest.id,
    skillVersion: manifest.version,
    capabilities: manifest.capabilities
  };
}

function toToolRegistrationOptions(
  registration: ToolRegistrationDescriptor | undefined
): ToolRegistrationOptions | undefined {
  if (!registration) return undefined;
  return {
    source: registration.source,
    skillId: registration.skillId,
    skillVersion: registration.skillVersion,
    capabilities: registration.capabilities
  };
}

function cloneManifest(manifest: SkillManifest): SkillManifest {
  return {
    ...manifest,
    ...(manifest.intents ? { intents: [...manifest.intents] } : {}),
    ...(manifest.capabilities ? { capabilities: [...manifest.capabilities] } : {}),
    ...(manifest.taskKinds ? { taskKinds: [...manifest.taskKinds] } : {}),
    ...(manifest.tools ? { tools: [...manifest.tools] } : {})
  };
}

function asItems<T>(value: SkillRegistrationItems<T> | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? [...value] : [value];
}

function addSkillActivators(
  target: Map<string, SkillActivationSource>,
  sources: ReadonlyMap<string, SkillActivationSource> | Readonly<Record<string, SkillActivationSource>> | undefined
): void {
  if (!sources) return;
  if (typeof (sources as ReadonlyMap<string, SkillActivationSource>).forEach === 'function') {
    (sources as ReadonlyMap<string, SkillActivationSource>).forEach((source, name) => target.set(name, source));
    return;
  }

  for (const [name, source] of Object.entries(sources)) target.set(name, source);
}

function readSkillActivation(skill: SkillInfo): SkillActivationSource | undefined {
  const candidate = skill as SkillInfo & {
    activate?: unknown;
    register?: unknown;
    registration?: unknown;
    body?: unknown;
  };
  const body = isRecord(candidate.body) ? candidate.body : undefined;
  const possibleSources = [
    candidate.activate,
    candidate.register,
    candidate.registration,
    body?.activate,
    body?.register,
    body?.registration
  ];

  return possibleSources.find(isSkillActivationSource);
}

function isSkillActivationSource(value: unknown): value is SkillActivationSource {
  return typeof value === 'function' || isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneSkill(skill: SkillInfo): SkillInfo {
  return { ...skill, frontmatter: { ...skill.frontmatter } };
}

function toManifest(skill: SkillInfo): SkillManifest {
  const frontmatter = skill.frontmatter;
  return {
    id: scalarString(firstDefined(frontmatter, ['id', 'name'])) ?? skill.name,
    version: scalarString(firstDefined(frontmatter, ['version'])) ?? '1.0.0',
    title: scalarString(firstDefined(frontmatter, ['title', 'name'])) ?? skill.name,
    description: skill.description,
    intents: asList(firstDefined(frontmatter, ['intents', 'intent'])),
    capabilities: asList(firstDefined(frontmatter, ['capabilities', 'capability'])),
    taskKinds: asList(firstDefined(frontmatter, ['taskKinds', 'task-kinds', 'task_kinds'])),
    tools: asList(firstDefined(frontmatter, ['tools', 'tool'])),
    activation: isActivation(firstDefined(frontmatter, ['activation']))
      ? (firstDefined(frontmatter, ['activation']) as SkillActivation)
      : 'lazy'
  };
}

function firstDefined(frontmatter: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (frontmatter[key] !== undefined && frontmatter[key] !== null) return frontmatter[key];
  }
  return undefined;
}

function scalarString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const result = typeof value === 'string' ? value.trim() : String(value);
  return result || undefined;
}

function asList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
    const uniqueItems = [...new Set(items)];
    return uniqueItems.length > 0 ? uniqueItems : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim().replace(/^\[|\]$/g, '');
    const items = normalized
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    const uniqueItems = [...new Set(items)];
    return uniqueItems.length > 0 ? uniqueItems : undefined;
  }
  return undefined;
}

function isActivation(value: unknown): value is SkillActivation {
  return value === 'eager' || value === 'lazy' || value === 'on-demand';
}
