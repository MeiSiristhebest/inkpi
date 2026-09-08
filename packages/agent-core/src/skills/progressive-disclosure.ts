import type { ExtensionAPI, SkillInfo } from '@inkpi/protocol';
import { ExtensionHost } from '../extension-host.js';
import { DynamicPluginLoader, type DynamicLoadSummary } from '../package-manager/dynamic-loader.js';
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
    for (const skill of this.discovery.discover()) this.skills.set(skill.name, skill);
    return [...this.skills.values()]
      .map((skill) => ({
        name: skill.name,
        description: skill.description,
        loaded: this.loaded.has(skill.name),
      }))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  discoverManifests(): SkillManifest[] {
    if (this.skills.size === 0) this.discover();
    return [...this.skills.values()].map(toManifest).sort((left, right) => left.id.localeCompare(right.id));
  }

  resolve(query: { intent?: string; capability?: string; taskKind?: string }): SkillManifest[] {
    return this.discoverManifests().filter((manifest) =>
      (!query.intent || manifest.intents?.includes(query.intent)) &&
      (!query.capability || manifest.capabilities?.includes(query.capability)) &&
      (!query.taskKind || manifest.taskKinds?.includes(query.taskKind)),
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
    id: String(frontmatter.id || skill.name),
    version: String(frontmatter.version || '1.0.0'),
    title: String(frontmatter.title || skill.name),
    description: skill.description,
    intents: asList(frontmatter.intents),
    capabilities: asList(frontmatter.capabilities),
    taskKinds: asList(frontmatter.taskKinds),
    tools: asList(frontmatter.tools),
    activation: isActivation(frontmatter.activation) ? frontmatter.activation : 'lazy',
  };
}

function asList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  if (typeof value === 'string' && value.trim()) return value.split(',').map((item) => item.trim()).filter(Boolean);
  return undefined;
}

function isActivation(value: unknown): value is SkillActivation {
  return value === 'eager' || value === 'lazy' || value === 'on-demand';
}
