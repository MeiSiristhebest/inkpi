import { type ExtensionFactory, ExtensionHost, ExtensionRunner } from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

describe('Custom Third-Party Extension Capability', () => {
  it('should allow third-party developers to define and register custom capabilities', async () => {
    // A third-party developer defines a custom extension using standard ExtensionFactory contract
    const customUserExtension: ExtensionFactory = (api) => {
      api.registerCommand({
        name: 'custom-command',
        description: 'Third-party user command',
        execute: async (args: string) => `Executed: ${args}`
      });

      api.registerTool({
        name: 'custom-tool',
        description: 'Third-party user tool',
        parameters: { type: 'object' },
        execute: async () => ({ content: [{ type: 'text', text: 'Custom tool result' }] })
      });

      api.addContextTransformer(async (messages) => {
        return [...messages, { role: 'user', content: 'Injected Context', timestamp: Date.now() }];
      });
    };

    const host = new ExtensionHost();
    const runner = new ExtensionRunner(host);
    const loaded = await runner.loadExtension(customUserExtension, 'my-custom-extension');

    expect(loaded).toBe(true);
    expect(host.getCommand('custom-command')).toBeDefined();
    expect(host.getTools().some((t) => t.name === 'custom-tool')).toBe(true);

    const transformed = await host.transformContext([{ role: 'user', content: 'Base message', timestamp: Date.now() }]);
    expect(transformed.length).toBe(2);
  });
});
