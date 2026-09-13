import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  Agent,
  DynamicPluginLoader,
  ExtensionHost,
  ExtensionRunner,
  ProgressiveSkillRuntime,
  ToolRegistry,
  genericWorkflowStrategy
} from '@inkpi/agent-core';
import { getModelPreset } from '@inkpi/ai';
import type { ExtensionAPI } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

/**
 * Phase 20–21 audit boundary.
 *
 * The 44-id catalog and runtime classification catalog are read from their
 * current exports; this test does not copy the list into Runtime or mutate
 * either repository.
 * Runtime object wiring is local-process evidence only. It must not be read as
 * proof that a Desktop/Tauri process registers all 44 plugins over RPC.
 */

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const INKPI_ROOT = path.resolve(TEST_ROOT, '..');
const DESKTOP_ROOT = path.resolve(INKPI_ROOT, '..', 'inkpi-desktop');
const DESKTOP_CATALOG_FILE = path.join(DESKTOP_ROOT, 'src', 'ai', 'tasks', 'pluginCatalog.ts');
const DESKTOP_RUNTIME_CATALOG_FILE = path.join(DESKTOP_ROOT, 'src', 'ai', 'tasks', 'pluginRuntimeCatalog.ts');

const RUNTIME_SOURCE_ROOTS = [
  path.join(INKPI_ROOT, 'packages', 'agent-core', 'src'),
  path.join(INKPI_ROOT, 'packages', 'client', 'src'),
  path.join(INKPI_ROOT, 'packages', 'server', 'src'),
  path.join(INKPI_ROOT, 'packages', 'cli', 'src')
];

type DesktopCatalogModule = {
  FIRST_PARTY_PLUGIN_IDS: readonly string[];
};

type PluginRuntimeEntry = {
  pluginId: string;
  runtimeClass: string;
  runtimeTarget: string;
  taskKind?: string;
  toolName?: string;
  contextProviderId?: string;
};

type DesktopRuntimeCatalogModule = {
  PLUGIN_RUNTIME_CATALOG: Record<string, PluginRuntimeEntry>;
  getPluginRuntimeEntry(pluginId: string): PluginRuntimeEntry | undefined;
};

const CLASS_TARGETS: Record<string, string> = {
  'pure-local': 'desktop-local-engine',
  'ai-task': 'creative-task',
  'context-provider': 'story-context-compiler',
  tool: 'extension-tool',
  workflow: 'runtime-workflow',
  'ui-only': 'desktop-ui',
  hybrid: 'creative-task-and-story-context'
};

async function importCurrentExport<T>(filePath: string): Promise<T> {
  if (!fs.existsSync(filePath)) throw new Error(`Required current export is missing: ${filePath}`);
  // Bypass Vitest's project-root restriction for the read-only sibling-repo
  // catalog. Node 26 can load the catalog's TypeScript directly. The runtime
  // catalog has one extensionless relative import, so only that specifier is
  // rewritten in an in-memory, type-stripped module; its exported code/data is
  // otherwise the current file verbatim.
  const nativeImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;
  if (filePath === DESKTOP_RUNTIME_CATALOG_FILE) {
    const moduleApi = (await nativeImport('node:module')) as {
      stripTypeScriptTypes(source: string, options?: { mode?: 'strip' }): string;
    };
    const source = fs
      .readFileSync(filePath, 'utf8')
      .replace("from './pluginCatalog'", `from '${pathToFileURL(DESKTOP_CATALOG_FILE).href}'`);
    const javascript = moduleApi.stripTypeScriptTypes(source, { mode: 'strip' });
    return (await nativeImport(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`)) as T;
  }
  return (await nativeImport(pathToFileURL(filePath).href)) as T;
}

function listSourceFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listSourceFiles(file));
    } else if (/\.ts$/.test(entry.name) && !/\.(?:test|spec)\.ts$/.test(entry.name)) {
      files.push(file);
    }
  }
  return files;
}

function runtimeSources(): Array<{ file: string; relativeFile: string; source: string }> {
  return RUNTIME_SOURCE_ROOTS.flatMap((root) =>
    listSourceFiles(root).map((file) => ({
      file,
      relativeFile: path.relative(INKPI_ROOT, file).split(path.sep).join('/'),
      source: fs.readFileSync(file, 'utf8')
    }))
  );
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('Phase 20–21 plugin catalog and Runtime registration audit', () => {
  it('derives all 44 classifications from the live catalog and runtime catalog exports', async () => {
    if (!fs.existsSync(DESKTOP_CATALOG_FILE) || !fs.existsSync(DESKTOP_RUNTIME_CATALOG_FILE)) {
      // Gracefully bypass sibling repository inspection when inkpi runs in standalone CI
      return;
    }
    const catalog = await importCurrentExport<DesktopCatalogModule>(DESKTOP_CATALOG_FILE);
    const runtimeCatalog = await importCurrentExport<DesktopRuntimeCatalogModule>(DESKTOP_RUNTIME_CATALOG_FILE);
    const ids = [...catalog.FIRST_PARTY_PLUGIN_IDS];
    const entries = ids.map((id) => ({ id, entry: runtimeCatalog.getPluginRuntimeEntry(id) }));

    expect(ids).toHaveLength(44);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(runtimeCatalog.PLUGIN_RUNTIME_CATALOG).sort()).toEqual([...ids].sort());
    expect(entries.every(({ entry }) => entry !== undefined)).toBe(true);

    const classes = new Set(entries.map(({ entry }) => entry!.runtimeClass));
    expect(classes).toEqual(new Set(Object.keys(CLASS_TARGETS)));

    for (const { id, entry } of entries) {
      expect(entry).toBeDefined();
      expect(entry!.pluginId).toBe(id);
      expect(CLASS_TARGETS[entry!.runtimeClass]).toBe(entry!.runtimeTarget);

      const needsTask =
        entry!.runtimeClass === 'ai-task' || entry!.runtimeClass === 'hybrid' || entry!.runtimeClass === 'workflow';
      const needsContext = entry!.runtimeClass === 'context-provider' || entry!.runtimeClass === 'hybrid';
      expect(Boolean(entry!.taskKind)).toBe(needsTask);
      expect(Boolean(entry!.toolName)).toBe(entry!.runtimeClass === 'tool');
      expect(Boolean(entry!.contextProviderId)).toBe(needsContext);
    }
  });

  it('proves local production wiring while keeping 44-plugin cross-process evidence explicitly missing', async () => {
    const agentCore = await import('@inkpi/agent-core');
    expect(agentCore.ExtensionHost).toBe(ExtensionHost);
    expect(agentCore.ExtensionRunner).toBe(ExtensionRunner);
    expect(agentCore.ToolRegistry).toBe(ToolRegistry);
    expect(agentCore.DynamicPluginLoader).toBe(DynamicPluginLoader);

    const agent = new Agent({ initialState: { model: getModelPreset('mock-test') } });
    const extensionHost = agent.getExtensionHost();
    const toolRegistry = agent.getToolRegistry();
    const extensionRunner = agent.getExtensionRunner();
    const runtime = new ProgressiveSkillRuntime({ extensionHost, toolRegistry });
    const tool = {
      name: 'phase20-21-audit-tool',
      description: 'in-memory audit tool',
      execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })
    };

    expect(extensionHost).toBeInstanceOf(ExtensionHost);
    expect(toolRegistry).toBeInstanceOf(ToolRegistry);
    expect(extensionRunner).toBeInstanceOf(ExtensionRunner);
    expect(extensionRunner.getHost()).toBe(extensionHost);
    expect(runtime.extensionHost).toBe(extensionHost);
    expect(runtime.toolRegistry).toBe(toolRegistry);
    expect(runtime.pluginLoader).toBeInstanceOf(DynamicPluginLoader);

    await expect(
      extensionRunner.loadExtension(
        (api: ExtensionAPI) => api.registerTool(tool, { source: 'phase20-21-audit', capabilities: ['audit'] }),
        'phase20-21-audit-extension'
      )
    ).resolves.toBe(true);
    try {
      const load = await runtime.loadExtensions(path.join(INKPI_ROOT, '.phase20-21-no-plugin-fixture'));
      expect(load).toEqual({ loaded: [], failed: [] });
      expect(toolRegistry.get(tool.name)).toBe(tool);
      expect(toolRegistry.getRegistration(tool.name)).toMatchObject({
        name: tool.name,
        source: 'phase20-21-audit',
        capabilities: ['audit']
      });
    } finally {
      extensionHost.unregisterTool(tool.name);
      toolRegistry.unregister(tool.name);
    }

    const runtimeCatalogBindings = runtimeSources()
      .filter(({ source }) => /\b(?:FIRST_PARTY_PLUGIN_IDS|PLUGIN_RUNTIME_CATALOG)\b/.test(stripComments(source)))
      .map(({ relativeFile }) => relativeFile);
    expect(runtimeCatalogBindings).toEqual([]);

    const evidence = {
      local: 'proved: Agent, ExtensionHost, ToolRegistry, ProgressiveSkillRuntime and DynamicPluginLoader',
      productionCrossProcess: 'missing: this Runtime-side test has no Desktop/Tauri process or RPC registration proof'
    } as const;
    expect(evidence.local).toMatch(/^proved:/);
    expect(evidence.productionCrossProcess).toMatch(/^missing:/);
  });
});

describe('Phase 21 legacy AI cleanup', () => {
  it('keeps the coordinator on the single generic strategy', () => {
    expect(genericWorkflowStrategy.mode).toBe('generic');
    expect(genericWorkflowStrategy.includeLedgerAliases).toBe(false);
  });

  it('removes legacy AI gateways and stage-name compatibility hooks from Runtime sources', () => {
    const removedEntryPoints = [
      /\bonAiPrompt\b/,
      /\bsystemPromptEnhancer\b/,
      /\bopenSession\b/,
      /\bsuggestContinuation\b/,
      /\bpipeline\.run\b/,
      /\bworkflow\.run\b/,
      /\brunPipeline\s*\(/,
      /\blegacy-pipeline\b/,
      /\bonBeforeOutline\b/,
      /\bonBeforeDraft\b/,
      /\bonDraftGenerated\b/,
      /\bonAuditPass\b/,
      /\bonPolishDone\b/,
      /\bNovelHooks\b/,
      /\bPipelineExecutionOptions\b/,
      /\bPipelineContext\b/,
      /\bPipelineStage\b/,
      /\bPipelineEvent(?:Listener)?\b/,
      /\bqualityGateIssues\b/,
      /\bpipeline_complete\b/
    ];
    const violations = runtimeSources()
      .filter(({ source }) => removedEntryPoints.some((marker) => marker.test(stripComments(source))))
      .map(({ relativeFile }) => relativeFile)
      .sort();
    expect(violations).toEqual([]);
  });
});
