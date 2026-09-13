import type {
  AgentTool,
  ContextTransformer,
  ExtensionAPI,
  InstructionEntry,
  SkillActivation,
  SkillInfo,
  SkillManifest,
  SkillResolveQuery,
  SkillRuntimeRegistrationSnapshot,
  ToolRegistrationDescriptor,
  ToolRegistrationOptions
} from '@inkpi/protocol';
import { SKILL_RUNTIME_PROTOCOL_VERSION } from '@inkpi/protocol';
import type { ContextPipeline } from '../context/index.js';
import type { ContextProvider } from '../context/types.js';
import { ExtensionHost } from '../extension-host.js';
import type { InstructionRegistry } from '../instructions/instruction-registry.js';
import { type DynamicLoadSummary, DynamicPluginLoader } from '../package-manager/dynamic-loader.js';
import type { TaskHandler } from '../tasks/task-handler.js';
import type { TaskRegistry } from '../tasks/task-registry.js';
import { ToolRegistry } from '../tools.js';
import { SkillDiscoveryEngine } from './skills.js';

export type {
  SkillActivation,
  SkillManifest,
  SkillRuntimeRegistrationSnapshot,
  SkillResolveQuery
} from '@inkpi/protocol';

export interface SkillManifestEntry {
  name: string;
  description: string;
  loaded: boolean;
}

export interface ProgressiveSkillRuntimeOptions {
  searchDirs?: string[];
  extensionHost?: ExtensionHost;
  toolRegistry?: ToolRegistry;
  taskRegistry?: TaskRegistry;
  contextPipeline?: ContextPipeline;
  instructionRegistry?: InstructionRegistry;
  discovery?: SkillDiscoveryEngine;
  activationAdapter?: LazySkillActivationAdapter;
  skillActivators?: ReadonlyMap<string, SkillActivationSource> | Readonly<Record<string, SkillActivationSource>>;
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
  instruction?: SkillRegistrationItems<InstructionEntry>;
  instructions?: SkillRegistrationItems<InstructionEntry>;
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
  readonly instructionRegistry?: InstructionRegistry;
  registerTask(handler: TaskHandler): void;
  registerTool(tool: AgentTool): void;
  registerContext(provider: ContextProvider): void;
  registerContextTransformer(transformer: ContextTransformer): () => void;
  registerInstruction(instruction: InstructionEntry): void;
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
  instructionRegistry?: InstructionRegistry;
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
  readonly instructionRegistry?: InstructionRegistry;

  private readonly activated = new Set<string>();
  private readonly pending = new Map<string, Promise<void>>();

  constructor(options: SkillActivationAdapterOptions) {
    this.extensionHost = options.extensionHost;
    this.toolRegistry = options.toolRegistry;
    this.taskRegistry = options.taskRegistry;
    this.contextPipeline = options.contextPipeline;
    this.instructionRegistry = options.instructionRegistry;
  }

  public async activate(skill: SkillInfo, source?: SkillActivationSource): Promise<void> {
    if (this.activated.has(skill.name)) return;

    const pending = this.pending.get(skill.name);
    if (pending) return pending;

    const activation = Promise.resolve().then(async () => {
      const undo: UndoAction[] = [];
      try {
        const context = this.createContext(skill, undo);
        this.registerPromptInstruction(skill, undo);
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
      instructionRegistry: this.instructionRegistry,
      registerTask: (handler: TaskHandler) => this.registerTask(skill.name, handler, undo),
      registerTool: (tool: AgentTool) => this.registerTool(tool, undo, skill),
      registerContext: (provider: ContextProvider) => this.registerContext(skill.name, provider, undo),
      registerContextTransformer: (transformer: ContextTransformer) =>
        this.registerContextTransformer(transformer, undo),
      registerInstruction: (instruction: InstructionEntry) => this.registerInstruction(skill, instruction, undo),
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

    for (const instruction of asItems(registration.instructions ?? registration.instruction)) {
      this.registerInstruction(skill, instruction, undo);
    }
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

  private registerInstruction(skill: SkillInfo, instruction: InstructionEntry, undo: UndoAction[]): void {
    if (!this.instructionRegistry) {
      throw new Error(`Skill '${skill.name}' cannot register an instruction without an InstructionRegistry`);
    }

    const manifest = toManifest(skill);
    const enriched: InstructionEntry = {
      ...instruction,
      version: instruction.version ?? manifest.version,
      source: instruction.source ?? `skill:${manifest.id}`,
      provenance: {
        source: instruction.provenance?.source ?? 'skill',
        ...instruction.provenance,
        skillId: instruction.provenance?.skillId ?? manifest.id,
        skillVersion: instruction.provenance?.skillVersion ?? manifest.version
      }
    };
    const existing = this.instructionRegistry.list().find((candidate) => candidate.id === enriched.id);
    if (existing) {
      if (sameInstruction(existing, enriched)) return;
      throw new Error(`Instruction already registered with different content: ${enriched.id}`);
    }

    this.instructionRegistry.register(enriched);
    undo.push(() => this.instructionRegistry?.unregister(enriched.id));
  }

  private registerPromptInstruction(skill: SkillInfo, undo: UndoAction[]): void {
    const content = skill.promptBody.trim();
    if (!content || !this.instructionRegistry) return;

    const manifest = toManifest(skill);
    this.registerInstruction(
      skill,
      {
        id: `skill.${manifest.id}`,
        scope: 'skill',
        content,
        version: manifest.version,
        source: `skill:${manifest.id}`,
        tags: manifest.taskKinds?.map((taskKind) => `task:${taskKind}`),
        provenance: {
          source: 'skill',
          skillId: manifest.id,
          skillVersion: manifest.version
        }
      },
      undo
    );
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
  readonly instructionRegistry?: InstructionRegistry;
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
    this.instructionRegistry = options.instructionRegistry ?? activationAdapter?.instructionRegistry;
    this.pluginLoader = new DynamicPluginLoader(this.extensionHost);
    this.activationAdapter =
      activationAdapter ??
      new LazySkillActivationAdapter({
        extensionHost: this.extensionHost,
        toolRegistry: this.toolRegistry,
        taskRegistry: this.taskRegistry,
        contextPipeline: this.contextPipeline,
        instructionRegistry: this.instructionRegistry
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

  /** Return a cloned metadata-only manifest for a skill name or manifest id. */
  getManifest(identifier: string): SkillManifest {
    const name = this.resolveSkillName(identifier);
    const skill = name ? (this.skills.get(name) ?? this.discovery.getSkill(name)) : undefined;
    if (!skill) throw new Error(`Skill not found: ${identifier}`);
    return cloneManifest(toManifest(skill));
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

  /** Return only process-safe metadata for a Desktop/Daemon handshake. */
  getRegistrationSnapshot(): SkillRuntimeRegistrationSnapshot {
    const manifests = this.discoverManifests();
    const manifestByName = new Map(
      [...this.skills.entries()].map(([name, skill]) => [name, toManifest(skill)] as const)
    );
    const skillId = (name: string): string => manifestByName.get(name)?.id ?? name;
    const activated = this.activationAdapter.listActivated().map(skillId).sort();
    return {
      protocolVersion: SKILL_RUNTIME_PROTOCOL_VERSION,
      skills: manifests.map(cloneManifest),
      loadedSkills: [...this.loaded].map(skillId).sort(),
      activatedSkills: activated,
      tools: this.toolRegistry.getRegistrations(),
      tasks:
        this.taskRegistry
          ?.list()
          .map((handler) => handler.id)
          .sort() ?? [],
      contextProviders:
        this.contextPipeline
          ?.list()
          .map((provider) => provider.id)
          .sort() ?? [],
      extensionHost: {
        toolNames: this.extensionHost
          .getTools()
          .map((tool) => tool?.name)
          .filter(isNonEmptyString)
          .sort(),
        commandNames: this.extensionHost
          .getCommands()
          .map((command) => command?.name)
          .filter(isNonEmptyString)
          .sort(),
        shortcutKeys: this.extensionHost
          .getShortcuts()
          .map((shortcut) => shortcut?.key)
          .filter(isNonEmptyString)
          .sort(),
        pipelineHookCount: this.extensionHost.getPipelineHooks().length
      },
      instructionVersion: this.instructionRegistry?.version(),
      instructions: this.instructionRegistry?.listReferences()
    };
  }

  load(name: string): SkillInfo {
    const resolvedName = this.resolveSkillName(name) ?? name;
    const skill = this.discovery.loadSkill(resolvedName) || this.skills.get(resolvedName);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    this.skills.set(resolvedName, skill);
    this.loaded.add(resolvedName);
    return { ...skill, frontmatter: { ...skill.frontmatter } };
  }

  async activate(name: string, source?: SkillActivationSource): Promise<SkillInfo> {
    const resolvedName = this.resolveSkillName(name) ?? name;
    if (this.activationAdapter.isActivated(resolvedName)) {
      const skill = this.skills.get(resolvedName) ?? this.discovery.getSkill(resolvedName);
      if (!skill) throw new Error(`Skill not found: ${name}`);
      return cloneSkill(skill);
    }

    const pending = this.pendingActivations.get(resolvedName);
    if (pending) return pending;

    const activation = Promise.resolve().then(async () => {
      const skill = this.load(resolvedName);
      const registeredSource = source ?? this.skillActivators.get(resolvedName) ?? readSkillActivation(skill);
      await this.activationAdapter.activate(skill, registeredSource);
      return cloneSkill(skill);
    });

    this.pendingActivations.set(resolvedName, activation);
    void activation.then(
      () => this.clearPendingActivation(resolvedName, activation),
      () => this.clearPendingActivation(resolvedName, activation)
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

  private resolveSkillName(identifier: string): string | undefined {
    if (this.skills.has(identifier)) return identifier;
    if (this.skills.size === 0) this.discover();
    for (const [name, skill] of this.skills) {
      if (toManifest(skill).id === identifier) return name;
    }
    return this.discovery.getSkill(identifier) ? identifier : undefined;
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function sameInstruction(left: InstructionEntry, right: InstructionEntry): boolean {
  return (
    left.id === right.id &&
    left.scope === right.scope &&
    left.content === right.content &&
    left.priority === right.priority &&
    left.enabled === right.enabled &&
    left.version === right.version &&
    left.source === right.source &&
    JSON.stringify(left.tags ?? []) === JSON.stringify(right.tags ?? []) &&
    JSON.stringify(left.provenance ?? {}) === JSON.stringify(right.provenance ?? {})
  );
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
