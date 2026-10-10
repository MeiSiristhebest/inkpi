import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  Agent,
  DynamicPluginLoader,
  type ExtensionGenerationAPI,
  ExtensionHost,
  ExtensionRunner
} from '@inkpi/agent-core';
import { getModelPreset } from '@inkpi/ai';
import type { AgentTool, ExtensionAPI } from '@inkpi/protocol';
import { describe, expect, it, vi } from 'vitest';

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function tool(text: string): AgentTool {
  return {
    name: 'versioned',
    description: 'Test versioned tool',
    parameters: { type: 'object' },
    implementationVersion: text,
    execute: async () => ({ content: [{ type: 'text', text }] })
  };
}
const asScoped = (api: ExtensionAPI) => api as ExtensionGenerationAPI;

describe('extension generation cutover', () => {
  it('keeps the old tools, commands and events visible throughout preparation and on failed initialization', async () => {
    const host = new ExtensionHost();
    const runner = new ExtensionRunner(host);
    let oldCalls = 0;
    let newCalls = 0;
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await runner.loadExtension((api: ExtensionAPI) => {
          api.registerTool(tool('old'));
          api.registerCommand({ name: 'versioned', execute: () => 'old' });
          api.on('event', () => {
            oldCalls++;
          });
        }, 'module')
      ).toBe(true);
      const prepared = deferred();
      const fail = deferred();
      const replacement = runner.loadExtension(async (api: ExtensionAPI) => {
        api.registerTool(tool('new'));
        api.registerCommand({ name: 'versioned', execute: () => 'new' });
        api.on('event', () => {
          newCalls++;
        });
        prepared.release();
        await fail.promise;
        throw new Error('initialization failed');
      }, 'module');
      await prepared.promise;
      expect(await host.getCommand('versioned').execute()).toBe('old');
      expect((await host.getTools()[0].execute('id', {})).content[0].text).toBe('old');
      await host.emit('event');
      fail.release();
      expect(await replacement).toBe(false);
      await host.emit('event');
      expect(oldCalls).toBe(2);
      expect(newCalls).toBe(0);
      expect(runner.getLoadedModules().map((module) => module.name)).toEqual(['module']);
      await runner.dispose();
    } finally {
      logs.mockRestore();
    }
  });

  it('invalidates saved callbacks and scopes, aborts their signal and preserves new registrations during old cleanup', async () => {
    const host = new ExtensionHost();
    const runner = new ExtensionRunner(host);
    let previous!: ExtensionGenerationAPI;
    let disposeCommand!: () => void;
    let disposed = 0;
    await runner.loadExtension((api: ExtensionAPI) => {
      previous = asScoped(api);
      api.registerTool(tool('old'));
      disposeCommand = (api as any).registerCommand({ name: 'command', execute: () => 'old' });
      previous.onDispose(() => {
        disposed++;
        disposeCommand();
        api.unregisterTool('versioned');
      });
    }, 'module');
    const stale = host.getTools()[0];
    await runner.loadExtension((api: ExtensionAPI) => {
      api.registerTool(tool('new'));
      api.registerCommand({ name: 'command', execute: () => 'new' });
    }, 'module');
    expect(previous.signal.aborted).toBe(true);
    expect(disposed).toBe(1);
    await expect(stale.execute('id', {})).rejects.toThrow(/inactive/);
    expect(() => previous.registerTool(tool('stale'))).toThrow(/inactive/);
    expect(await host.getCommand('command').execute()).toBe('new');
    expect((await host.getTools()[0].execute('id', {})).content[0].text).toBe('new');
    await runner.dispose();
  });

  it('fences an old asynchronous tool result and progress after a real cutover', async () => {
    const host = new ExtensionHost();
    const runner = new ExtensionRunner(host);
    const entered = deferred();
    const finish = deferred();
    let executionSignal: AbortSignal | undefined;
    await runner.loadExtension(
      (api: ExtensionAPI) =>
        api.registerTool({
          ...tool('old'),
          execute: async (_id: string, _args: unknown, signal?: AbortSignal, update?: any) => {
            executionSignal = signal;
            entered.release();
            await finish.promise;
            update?.({ content: [{ type: 'text', text: 'stale progress' }] });
            return { content: [{ type: 'text', text: 'stale result' }] };
          }
        }),
      'module'
    );
    const progress = vi.fn();
    const pending = host.getTools()[0].execute('id', {}, undefined, progress);
    await entered.promise;
    await runner.loadExtension((api: ExtensionAPI) => api.registerTool(tool('new')), 'module');
    expect(executionSignal?.aborted).toBe(true);
    finish.release();
    await expect(pending).rejects.toThrow(/inactive/);
    expect(progress).not.toHaveBeenCalled();
    await runner.dispose();
  });

  it('checks the dependency graph before preparation and disposes dependents in reverse order despite failures', async () => {
    const runner = new ExtensionRunner();
    const prepared = vi.fn();
    await expect(runner.loadAll([{ name: 'a', dependencies: ['missing'], factory: prepared }])).rejects.toThrow(
      /Missing/
    );
    await expect(
      runner.loadAll([
        { name: 'a', dependencies: ['b'], factory: prepared },
        { name: 'b', dependencies: ['a'], factory: prepared }
      ])
    ).rejects.toThrow(/Cyclic/);
    expect(prepared).not.toHaveBeenCalled();
    const order: string[] = [];
    await runner.loadAll([
      {
        name: 'consumer',
        dependencies: ['service'],
        factory: () => {
          order.push('prepare-consumer');
        },
        dispose: () => {
          order.push('dispose-consumer');
          throw new Error('cleanup failure');
        }
      },
      {
        name: 'service',
        factory: () => {
          order.push('prepare-service');
        },
        dispose: () => {
          order.push('dispose-service');
        }
      }
    ]);
    expect(order).toEqual(['prepare-service', 'prepare-consumer']);
    await expect(runner.unloadExtension('service')).rejects.toThrow(/required/);
    const snapshot = runner.getLoadedModules();
    snapshot.find((module) => module.name === 'consumer')!.dependencies = [];
    await expect(runner.dispose()).rejects.toThrow(/disposal failed/);
    expect(order.slice(2)).toEqual(['dispose-consumer', 'dispose-service']);
    expect(runner.getLoadedModules()).toEqual([]);
    await runner.dispose();
  });

  it('does not delete later registration ownership, even when an object is reused', () => {
    const host = new ExtensionHost();
    const sameTool = tool('same');
    const sameCommand = { name: 'same', execute: () => 'same' };
    const oldTool = host.registerTool(sameTool);
    const oldCommand = host.registerCommand(sameCommand);
    const oldShortcut = host.registerShortcut({ key: 'same', execute: () => true });
    host.registerTool(sameTool);
    host.registerCommand(sameCommand);
    host.registerShortcut({ key: 'same', execute: () => true });
    oldTool();
    oldCommand();
    oldShortcut();
    expect(host.getTools()).toEqual([sameTool]);
    expect(host.getCommand('same')).toBe(sameCommand);
    expect(host.getShortcuts()).toHaveLength(1);
  });

  it.each(['preparation', 'collision'])('preserves the entire old group after a batch %s failure', async (failure) => {
    const host = new ExtensionHost();
    const runner = new ExtensionRunner(host);
    const disposed: string[] = [];
    const oldScopes: ExtensionGenerationAPI[] = [];
    const group = (version: string) => [
      {
        name: 'service',
        factory: (api: ExtensionAPI) => {
          if (version === 'old') oldScopes.push(asScoped(api));
          api.registerCommand({ name: 'service', execute: () => version });
        },
        dispose: () => {
          disposed.push(`${version}-service`);
        }
      },
      {
        name: 'consumer',
        dependencies: ['service'],
        factory: (api: ExtensionAPI) => {
          if (version === 'old') oldScopes.push(asScoped(api));
          api.registerCommand({ name: 'consumer', execute: () => version });
        },
        dispose: () => {
          disposed.push(`${version}-consumer`);
        }
      }
    ];
    await runner.loadAll(group('old'));
    const ready = deferred();
    const finish = deferred();
    const replacement = group('new');
    replacement[1].factory = async (api: ExtensionAPI) => {
      api.registerCommand({ name: failure === 'collision' ? 'service' : 'consumer', execute: () => 'bad' });
      ready.release();
      await finish.promise;
      if (failure === 'preparation') throw new Error('consumer failed');
    };
    const pending = runner.loadAll(replacement);
    await ready.promise;
    expect(await host.getCommand('service').execute()).toBe('old');
    expect(await host.getCommand('consumer').execute()).toBe('old');
    finish.release();
    await expect(pending).rejects.toThrow(failure === 'preparation' ? /consumer failed/ : /Duplicate/);
    expect(await host.getCommand('service').execute()).toBe('old');
    expect(await host.getCommand('consumer').execute()).toBe('old');
    expect(oldScopes.map((scope) => scope.signal.aborted)).toEqual([false, false]);
    expect(disposed).toEqual(['new-consumer', 'new-service']);
    for (const scope of oldScopes) {
      scope.signal.addEventListener('abort', () => {
        expect(host.getCommand('service')).toBeDefined();
        expect(host.getCommand('consumer')).toBeDefined();
      });
    }
    await runner.loadAll(group('new'));
    expect(await host.getCommand('service').execute()).toBe('new');
    expect(await host.getCommand('consumer').execute()).toBe('new');
    expect(oldScopes.every((scope) => scope.signal.aborted)).toBe(true);
    expect(disposed.slice(2)).toEqual(['old-consumer', 'old-service']);
    await runner.dispose();
  });

  it('refuses a cleared pending batch before mounting any staged registrations', async () => {
    const host = new ExtensionHost();
    const runner = new ExtensionRunner(host);
    const ready = deferred();
    const finish = deferred();
    const loading = runner.loadAll([
      { name: 'a', factory: (api) => api.registerTool(tool('pending')) },
      {
        name: 'b',
        dependencies: ['a'],
        factory: async (api) => {
          api.registerCommand({ name: 'pending', execute: () => true });
          ready.release();
          await finish.promise;
        }
      }
    ]);
    await ready.promise;
    host.clear();
    host.registerCommand({ name: 'external', execute: () => true });
    finish.release();
    await expect(loading).rejects.toThrow(/inactive/);
    expect(host.getTools()).toEqual([]);
    expect(host.getCommands().map((command) => command.name)).toEqual(['external']);
    expect(runner.getLoadedModules()).toEqual([]);
    await runner.dispose();
    expect(host.getCommand('external')).toBeDefined();
  });

  it('rejects registration theft without losing a generation active before it', async () => {
    const host = new ExtensionHost();
    const runner = new ExtensionRunner(host);
    let scope!: ExtensionGenerationAPI;
    await runner.loadExtension((api: ExtensionAPI) => {
      scope = asScoped(api);
      api.registerTool(tool('owned'));
    }, 'module');
    const external = { ...tool('external'), name: 'external' };
    host.registerTool(external);
    expect(() => scope.registerTool({ ...tool('stolen'), name: 'external' })).toThrow(/another owner/);
    expect(host.getTools().find((entry) => entry.name === 'external')).toBe(external);
    expect(
      (
        await host
          .getTools()
          .find((entry) => entry.name === 'versioned')
          .execute('id', {})
      ).content[0].text
    ).toBe('owned');
    await runner.dispose();
    expect(host.getTools()).toEqual([external]);
  });

  it('clearing a host fences pending preparations and all retained callbacks', async () => {
    const host = new ExtensionHost();
    const runner = new ExtensionRunner(host);
    const ready = deferred();
    const finish = deferred();
    let scope!: ExtensionGenerationAPI;
    const logs = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const loading = runner.loadExtension(async (api: ExtensionAPI) => {
        scope = asScoped(api);
        api.registerTool(tool('pending'));
        ready.release();
        await finish.promise;
      }, 'module');
      await ready.promise;
      host.clear();
      finish.release();
      expect(await loading).toBe(false);
      expect(scope.signal.aborted).toBe(true);
      expect(host.getTools()).toEqual([]);
      await runner.dispose();
    } finally {
      logs.mockRestore();
    }
  });

  it('shares the Agent runner across workspace reloads and resource disposal', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkpi-agent-generation-'));
    const agent = new Agent({ initialState: { model: getModelPreset('mock-test') } });
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const plugins = path.join(dir, '.inkpi', 'plugins');
      await fs.mkdir(plugins, { recursive: true });
      const file = path.join(plugins, 'plugin.mjs');
      const write = (version: string) =>
        fs.writeFile(file, `export default (api) => api.registerCommand({name:'workspace',execute:()=> '${version}'})`);
      await write('old');
      await agent.loadWorkspacePlugins(dir);
      const stale = agent.getExtensionHost().getCommand('workspace');
      await write('new');
      await agent.loadWorkspacePlugins(dir);
      expect(await agent.getExtensionHost().getCommand('workspace').execute()).toBe('new');
      await expect(stale.execute()).rejects.toThrow(/inactive/);
      expect(agent.getExtensionRunner().getLoadedModules()).toHaveLength(1);
      await agent.getExtensionRunner().dispose();
      expect(agent.getExtensionHost().getCommands()).toEqual([]);
    } finally {
      await agent.getExtensionRunner().dispose();
      log.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it.each(['mjs', 'cjs'])('uses generation replacement in the actual %s dynamic file loader', async (extension) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inkpi-extension-generation-'));
    const host = new ExtensionHost();
    const loader = new DynamicPluginLoader(host);
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const filename = `plugin.${extension}`;
      const file = path.join(dir, filename);
      const prefix = extension === 'mjs' ? 'export default' : 'module.exports =';
      await fs.writeFile(file, `${prefix} (api) => api.registerCommand({name:'dynamic',execute:()=> 'old'})`);
      expect((await loader.loadFromDirectory(dir)).loaded).toEqual([filename]);
      await fs.writeFile(
        file,
        `${prefix} (api) => {api.registerCommand({name:'dynamic',execute:()=> 'bad'}); throw new Error('failed')}`
      );
      expect((await loader.loadFromDirectory(dir)).failed).toHaveLength(1);
      expect(await host.getCommand('dynamic').execute()).toBe('old');
      await fs.writeFile(file, `${prefix} (api) => api.registerCommand({name:'dynamic',execute:()=> 'new'})`);
      expect((await loader.loadFromDirectory(dir)).loaded).toEqual([filename]);
      expect(await host.getCommand('dynamic').execute()).toBe('new');
    } finally {
      await loader.dispose();
      host.clear();
      log.mockRestore();
      error.mockRestore();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
