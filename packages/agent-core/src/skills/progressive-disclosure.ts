import type { ExtensionAPI, SkillInfo } from '@inkpi/protocol';
import { ExtensionHost } from '../extension-host.js';
import { type DynamicLoadSummary, DynamicPluginLoader } from '../package-manager/dynamic-loader.js';
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

export interface ProgressiveSkillRuntimeOptions {
  searchDirs?: string[];
  extensionHost?: ExtensionHost;
  toolRegistry?: ToolRegistry;
  discovery?: SkillDiscoveryEngine;
}

export interface SkillResolveQuery {
  intent?: string;
  capability?: string;
  taskKind?: string;
  activation?: SkillActivation;
}

/**
 * Keeps skill discovery cheap and loads full prompt bodies only on demand.
 * Dynamic extensions continue to use the existing ExtensionHost and loader;
 * tools are mirrored into the existing ToolRegistry after activation.
 */
export class ProgressiveSkillRuntime {
  readonly extensionHost: ExtensionHost;
  readonly toolRegistry: ToolRegistry;
  readonly pluginLoader: DynamicPluginLoader;
  private readonly discovery: SkillDiscoveryEngine;
  private readonly skills = new Map<string, SkillInfo>();
  private readonly loaded = new Set<string>();

  constructor(options: ProgressiveSkillRuntimeOptions = {}) {
    this.extensionHost = options.extensionHost ?? new ExtensionHost();
    this.toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.pluginLoader = new DynamicPluginLoader(this.extensionHost);
    this.discovery = options.discovery ?? new SkillDiscoveryEngine(options.searchDirs ?? []);
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

  registerSkill(skill: SkillInfo): void {
    this.skills.set(skill.name, skill);
  }

  listLoaded(): string[] {
    return [...this.loaded].sort();
  }

  load(name: string): SkillInfo {
    const skill = this.discovery.loadSkill(name) || this.skills.get(name);
    if (!skill) throw new Error(`Skill not found: ${name}`);
    this.skills.set(name, skill);
    this.loaded.add(name);
    return { ...skill, frontmatter: { ...skill.frontmatter } };
  }

  async loadExtensions(directory: string): Promise<DynamicLoadSummary> {
    const summary = await this.pluginLoader.loadFromDirectory(directory);
    for (const tool of this.extensionHost.getTools()) {
      if (!this.toolRegistry.get(tool.name)) this.toolRegistry.register(tool);
    }
    return summary;
  }

  getExtensionApi(): ExtensionAPI {
    return this.extensionHost;
  }
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
    return items.length > 0 ? items : undefined;
  }
  if (typeof value === 'string' && value.trim()) {
    const normalized = value.trim().replace(/^\[|\]$/g, '');
    const items = normalized
      .split(',')
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function isActivation(value: unknown): value is SkillActivation {
  return value === 'eager' || value === 'lazy' || value === 'on-demand';
}
