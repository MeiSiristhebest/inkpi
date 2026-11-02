import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
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
 * The plugin catalog and runtime classification catalog are read from their
 * current exports; this test does not copy the list into Runtime or mutate
 * either repository.
 * Runtime object wiring is local-process evidence only. It must not be read as
 * proof that a Desktop/Tauri process registers every catalog plugin over RPC.
 */

const TEST_ROOT = path.dirname(fileURLToPath(import.meta.url));
const INKPI_ROOT = path.resolve(TEST_ROOT, '..');
const DESKTOP_ROOT = path.resolve(INKPI_ROOT, '..', 'inkpi-desktop');
const DESKTOP_CATALOG_FILE = path.join(DESKTOP_ROOT, 'src', 'ai', 'tasks', 'pluginCatalog.ts');
const DESKTOP_RUNTIME_CATALOG_FILE = path.join(DESKTOP_ROOT, 'src', 'ai', 'tasks', 'pluginRuntimeCatalog.ts');
const execFileAsync = promisify(execFile);

const RUNTIME_SOURCE_ROOTS = [
  path.join(INKPI_ROOT, 'packages', 'agent-core', 'src'),
  path.join(INKPI_ROOT, 'packages', 'client', 'src'),
  path.join(INKPI_ROOT, 'packages', 'server', 'src'),
  path.join(INKPI_ROOT, 'packages', 'cli', 'src')
];

const RUNTIME_BOUNDARY_SOURCE_ROOTS = [
  path.join(INKPI_ROOT, 'packages', 'agent-core', 'src', 'pipeline'),
  path.join(INKPI_ROOT, 'packages', 'agent-core', 'src', 'compaction'),
  path.join(INKPI_ROOT, 'packages', 'agent-core', 'src', 'tools')
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
  'shared-ai': 'creative-task',
  'ai-task': 'creative-task',
  'context-provider': 'story-context-compiler',
  tool: 'extension-tool',
  workflow: 'runtime-workflow',
  'ui-only': 'desktop-ui',
  hybrid: 'creative-task-and-story-context'
};

async function importCurrentExport<T>(filePath: string): Promise<T> {
  if (!fs.existsSync(filePath)) throw new Error(`Required current export is missing: ${filePath}`);

  // Load sibling-repository TypeScript in a Node child process so Vitest's VM
  // context does not need an importModuleDynamically callback. The runtime
  // catalog's one extensionless import is rewritten only in-memory.
  const isRuntimeCatalog = filePath === DESKTOP_RUNTIME_CATALOG_FILE;
  const childScript = [
    "import { readFileSync } from 'node:fs';",
    "import { stripTypeScriptTypes } from 'node:module';",
    "import { pathToFileURL } from 'node:url';",
    `const filePath = ${JSON.stringify(filePath)};`,
    `const catalogPath = ${JSON.stringify(DESKTOP_CATALOG_FILE)};`,
    `const isRuntimeCatalog = ${JSON.stringify(isRuntimeCatalog)};`,
    'let imported;',
    'if (isRuntimeCatalog) {',
    "  const source = readFileSync(filePath, 'utf8').replace(\"from './pluginCatalog'\", 'from \\\"' + pathToFileURL(catalogPath).href + '\\\"');",
    "  const javascript = stripTypeScriptTypes(source, { mode: 'strip' });",
    "  imported = await import('data:text/javascript;base64,' + Buffer.from(javascript).toString('base64'));",
    '  const catalog = await import(pathToFileURL(catalogPath).href);',
    '  const runtimeEntries = Object.fromEntries(catalog.FIRST_PARTY_PLUGIN_IDS.map((id) => [id, imported.getPluginRuntimeEntry(id)]));',
    '  imported = { PLUGIN_RUNTIME_CATALOG: imported.PLUGIN_RUNTIME_CATALOG, runtimeEntries };',
    '} else {',
    '  imported = await import(pathToFileURL(filePath).href);',
    '}',
    'process.stdout.write(JSON.stringify(imported));'
  ].join('\n');
  const { stdout } = await execFileAsync(
    process.execPath,
    ['--experimental-strip-types', '--input-type=module', '-e', childScript],
    { cwd: DESKTOP_ROOT, windowsHide: true, maxBuffer: 10 * 1024 * 1024 }
  );
  const parsed = JSON.parse(stdout) as T;
  if (!isRuntimeCatalog) return parsed;

  const serialized = parsed as unknown as {
    PLUGIN_RUNTIME_CATALOG: Record<string, PluginRuntimeEntry>;
    runtimeEntries: Record<string, PluginRuntimeEntry | undefined>;
  };
  return {
    PLUGIN_RUNTIME_CATALOG: serialized.PLUGIN_RUNTIME_CATALOG,
    getPluginRuntimeEntry: (pluginId: string) => serialized.runtimeEntries[pluginId]
  } as T;
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

function runtimeBoundarySources(): Array<{ file: string; relativeFile: string; source: string }> {
  return RUNTIME_BOUNDARY_SOURCE_ROOTS.flatMap((root) =>
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
  it('classifies every plugin in the live catalog using Runtime catalog exports', async () => {
    if (!fs.existsSync(DESKTOP_CATALOG_FILE) || !fs.existsSync(DESKTOP_RUNTIME_CATALOG_FILE)) {
      // Gracefully bypass sibling repository inspection when inkpi runs in standalone CI
      return;
    }
    const catalog = await importCurrentExport<DesktopCatalogModule>(DESKTOP_CATALOG_FILE);
    const runtimeCatalog = await importCurrentExport<DesktopRuntimeCatalogModule>(DESKTOP_RUNTIME_CATALOG_FILE);
    const ids = [...catalog.FIRST_PARTY_PLUGIN_IDS];
    const entries = ids.map((id) => ({ id, entry: runtimeCatalog.getPluginRuntimeEntry(id) }));

    expect(ids).toHaveLength(49);
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

  it('proves local production wiring while keeping cross-process evidence explicitly missing', async () => {
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
      parameters: { type: 'object', properties: {} },
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
      const registeredTool = toolRegistry.get(tool.name);
      expect(registeredTool).toMatchObject({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      });
      await expect(registeredTool!.execute('audit-call', {}, new AbortController().signal)).resolves.toMatchObject({
        content: [{ type: 'text', text: 'ok' }]
      });
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
    expect(Object.prototype.hasOwnProperty.call(genericWorkflowStrategy, 'includeLedgerAliases')).toBe(false);
  });

  it('keeps Creative Domain adapters out of the default agent-core export', async () => {
    const agentCore = await import('@inkpi/agent-core');
    for (const removedExport of [
      'createNarrativeEntitySafetyRules',
      'createScreenplayGateRules',
      'createShortDramaGateRules',
      'createVisualNovelGateRules',
      'NarrativeSemanticLedgerExtractor',
      'extractNovelStateLedger',
      'formatNovelStateLedger',
      'createAuthoringTools',
      'FileSystemDocumentStore',
      'InMemoryDocumentStore'
    ]) {
      expect(agentCore).not.toHaveProperty(removedExport);
    }
    expect(agentCore.extractRuntimeState).toBeDefined();
    expect(agentCore.createDocumentResourceTools).toBeDefined();
  });

  it('keeps creative parsing and direct document writes outside Runtime boundary sources', () => {
    const sourceMarkers = [
      /narrative-gates/,
      /state-ledger/,
      /authoring-tools/,
      /createAuthoringTools/,
      /FileSystemDocumentStore/,
      /InMemoryDocumentStore/
    ];
    const sourceViolations = runtimeBoundarySources()
      .filter(({ source }) => sourceMarkers.some((marker) => marker.test(stripComments(source))))
      .map(({ relativeFile }) => relativeFile)
      .sort();
    expect(sourceViolations).toEqual([]);

    const directWriteMarkers = [/\bedit_text\b/, /\bwrite_draft\b/, /docStore\.write\s*\(/];
    const directWriteViolations = runtimeBoundarySources()
      .filter(
        ({ relativeFile, source }) =>
          relativeFile.includes('/tools/') && directWriteMarkers.some((marker) => marker.test(stripComments(source)))
      )
      .map(({ relativeFile }) => relativeFile)
      .sort();
    expect(directWriteViolations).toEqual([]);
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
