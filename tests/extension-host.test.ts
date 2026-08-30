import { describe, it, expect } from 'vitest';
import { ExtensionHost, ExtensionRunner } from '@inkpi/agent-core';
import type { AgentTool, SlashCommand, ShortcutHandler, AgentMessage } from '@inkpi/protocol';

describe('@inkpi/agent-core -> ExtensionHost & ExtensionRunner (Generic Extension Ecosystem)', () => {
  it('should register, list, and unregister tools dynamically', () => {
    const host = new ExtensionHost();
    const mockTool: AgentTool<{ query: string }> = {
      name: 'dynamic_tool',
      description: '动态工具',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
      execute: async (_id, p) => ({ content: [{ type: 'text', text: p.query }] })
    };

    host.registerTool(mockTool);
    expect(host.getTools().length).toBe(1);
    expect(host.getTools()[0].name).toBe('dynamic_tool');

    const ok = host.unregisterTool('dynamic_tool');
    expect(ok).toBe(true);
    expect(host.getTools().length).toBe(0);

    const fail = host.unregisterTool('non_existent');
    expect(fail).toBe(false);
  });

  it('should register, list, and unregister slash commands dynamically', async () => {
    const host = new ExtensionHost();
    const cmd: SlashCommand = {
      name: 'echo',
      description: 'Echo command',
      execute: async (args) => `Echo: ${args}`
    };

    host.registerCommand(cmd);
    expect(host.getCommands().length).toBe(1);
    expect(host.getCommand('echo')).toBe(cmd);

    const result = await host.getCommand('echo')?.execute('test');
    expect(result).toBe('Echo: test');

    const unreg = host.unregisterCommand('echo');
    expect(unreg).toBe(true);
    expect(host.getCommand('echo')).toBeUndefined();
  });

  it('should register, list, and unregister keyboard shortcuts', async () => {
    const host = new ExtensionHost();
    const shortcut: ShortcutHandler = {
      key: 'Ctrl+Shift+L',
      description: 'Trigger lint',
      execute: async () => true
    };

    host.registerShortcut(shortcut);
    expect(host.getShortcuts().length).toBe(1);

    const executed = await host.getShortcuts()[0].execute();
    expect(executed).toBe(true);

    const unreg = host.unregisterShortcut('Ctrl+Shift+L');
    expect(unreg).toBe(true);
    expect(host.getShortcuts().length).toBe(0);
  });

  it('should subscribe to and emit lifecycle events with unregister support', async () => {
    const host = new ExtensionHost();
    const receivedEvents: string[] = [];

    const unreg = host.on('document_saved', (documentId: string) => {
      receivedEvents.push(documentId);
    });

    await host.emit('document_saved', 'ch_101');
    expect(receivedEvents).toEqual(['ch_101']);

    unreg();
    await host.emit('document_saved', 'ch_102');
    expect(receivedEvents).toEqual(['ch_101']); // Not called after unregister!
  });

  it('should execute context transformation pipeline with add/remove support', async () => {
    const host = new ExtensionHost();

    const removeTf = host.addContextTransformer(async (messages) => {
      return [{ role: 'custom', customType: 'injected_context', content: '上下文切片' }, ...messages];
    });

    const initial: AgentMessage[] = [{ role: 'user', content: '正文' }];
    const transformed = await host.transformContext(initial);
    expect(transformed.length).toBe(2);
    expect(transformed[0].role).toBe('custom');

    removeTf();
    const untransformed = await host.transformContext(initial);
    expect(untransformed.length).toBe(1);
  });

  it('should load extensions safely through ExtensionRunner and isolate errors', async () => {
    const host = new ExtensionHost();
    const runner = new ExtensionRunner(host);

    // 1. Success load
    const ok = await runner.loadExtension(async (pi) => {
      pi.registerCommand({
        name: 'greet',
        description: 'Greet',
        execute: async () => 'Hello'
      });
    }, 'greet-extension');
    expect(ok).toBe(true);
    expect(host.getCommand('greet')).toBeDefined();
    expect(runner.getLoadedDocuments().length).toBe(1);

    // 2. Error isolated load
    const fail = await runner.loadExtension(async () => {
      throw new Error('Extension crash during init');
    }, 'broken-extension');
    expect(fail).toBe(false);
    expect(runner.getLoadedDocuments().length).toBe(1); // Didn't crash the host!

    // 3. Batch loadAll
    await runner.loadAll([
      {
        name: 'ext_a',
        factory: (pi) => {
          pi.registerShortcut({ key: 'Tab', description: 'Tab', execute: async () => true });
        }
      }
    ]);
    expect(host.getShortcuts().length).toBe(1);
  });
});
