import { type ExtensionFactory, ExtensionHost, ExtensionRunner } from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

describe('Novel Extensions Infrastructure & Interface Contracts', () => {
  it('should allow loading and registering tools/commands via ExtensionRunner', async () => {
    const mockSampleExtension: ExtensionFactory = (api) => {
      api.registerTool({
        name: 'sample_custom_tool',
        description: '用于测试接口注册机制的自定义工具',
        parameters: { type: 'object', properties: { key: { type: 'string' } } },
        execute: async (_id: string, params: { key?: string }) => ({
          content: [{ type: 'text', text: `Result for ${params.key || 'default'}` }],
          details: { key: params.key }
        })
      });

      api.registerCommand({
        name: 'sample_command',
        description: '测试自定义命令',
        execute: async (args: string) => `Command executed with: ${args}`
      });
    };

    const runner = new ExtensionRunner();
    await runner.loadExtension(mockSampleExtension, 'mock-sample');

    const api = runner.getApi();
    const tools = api.getTools();
    expect(tools.some((t) => t.name === 'sample_custom_tool')).toBe(true);

    const commands = api.getCommands();
    expect(commands.some((c) => c.name === 'sample_command')).toBe(true);

    const tool = tools.find((t) => t.name === 'sample_custom_tool')!;
    const res = await tool.execute('call_1', { key: 'test-value' });
    expect((res.content[0] as any).text).toBe('Result for test-value');

    const cmd = commands.find((c) => c.name === 'sample_command')!;
    const cmdRes = await cmd.execute('arg1');
    expect(cmdRes).toBe('Command executed with: arg1');
  });

  it('should support UI delegate interface bindings (showSelectList, showInput, flashNotification)', async () => {
    let selectListShown = false;
    let flashTriggered = false;
    let inputPromptShown = false;

    const host = new ExtensionHost({
      showSelectList: async (opt) => {
        selectListShown = true;
        return opt.assets?.[0]?.value;
      },
      showInput: async (opt) => {
        inputPromptShown = true;
        return `inputted_${opt.defaultValue || ''}`;
      },
      flashNotification: () => {
        flashTriggered = true;
      }
    });

    const selected = await host.showSelectList({
      title: '选择测试项目',
      assets: [{ id: '1', label: '项目一', value: 'opt_1' }]
    });

    expect(selectListShown).toBe(true);
    expect(selected).toBe('opt_1');

    const inputVal = await host.showInput({ title: '输入测试', defaultValue: 'val' });
    expect(inputPromptShown).toBe(true);
    expect(inputVal).toBe('inputted_val');

    host.flashNotification('保存成功');
    expect(flashTriggered).toBe(true);
  });

  it('should support novel lifecycle hooks registration interface', async () => {
    const host = new ExtensionHost();
    let outlineHookCalled = false;
    let draftHookCalled = false;
    let auditHookCalled = false;
    let polishHookCalled = false;

    const unsubscribe = host.registerNovelHooks({
      onBeforeOutline: async ({ userPrompt }) => {
        outlineHookCalled = true;
        return `${userPrompt} (hooked)`;
      },
      onDraftGenerated: async ({ draftText }) => {
        draftHookCalled = true;
        return `${draftText}\n[Draft hook]`;
      },
      onAuditPass: async () => {
        auditHookCalled = true;
      },
      onPolishDone: async ({ polishedText }) => {
        polishHookCalled = true;
        return `${polishedText}\n[Polish hook]`;
      }
    });

    const hooks = host.getNovelHooks();
    expect(hooks.length).toBe(1);

    const outPrompt = await hooks[0].onBeforeOutline!({
      workspaceTitle: 'workspace',
      documentTitle: 'document',
      userPrompt: '大纲提示'
    });
    expect(outlineHookCalled).toBe(true);
    expect(outPrompt).toContain('(hooked)');

    const draftOut = await hooks[0].onDraftGenerated!({
      workspaceTitle: 'workspace',
      documentTitle: 'document',
      draftText: '草稿'
    });
    expect(draftHookCalled).toBe(true);
    expect(draftOut).toContain('[Draft hook]');

    await hooks[0].onAuditPass!({ auditNotes: [], passed: true });
    expect(auditHookCalled).toBe(true);

    const polishOut = await hooks[0].onPolishDone!({ polishedText: '润色文本' });
    expect(polishHookCalled).toBe(true);
    expect(polishOut).toContain('[Polish hook]');

    unsubscribe();
    expect(host.getNovelHooks().length).toBe(0);
  });

  it('should report unavailable UI capabilities without a UI delegate', async () => {
    const host = new ExtensionHost(); // No UI delegate provided

    const selected = await host.showSelectList({
      title: '测试无委托选择',
      assets: [{ id: '1', label: '默认项', value: 42 }]
    });
    expect(selected).toBeUndefined();

    const input = await host.showInput({ title: '测试输入', defaultValue: '初始值' });
    expect(input).toBeUndefined();

    // Tool registration and unregistration
    host.registerTool({
      name: 'temp_tool',
      description: 'temp',
      execute: async () => ({ content: [] })
    });
    expect(host.getTools().some((t) => t.name === 'temp_tool')).toBe(true);
    expect(host.unregisterTool('temp_tool')).toBe(true);
    expect(host.getTools().some((t) => t.name === 'temp_tool')).toBe(false);

    // Command registration and unregistration
    host.registerCommand({
      name: 'temp_cmd',
      description: 'temp cmd',
      execute: async () => 'done'
    });
    expect(host.getCommand('temp_cmd')).toBeDefined();
    expect(host.unregisterCommand('temp_cmd')).toBe(true);
    expect(host.getCommand('temp_cmd')).toBeUndefined();

    expect(host.unregisterShortcut('non_existent')).toBe(false);
  });
});
