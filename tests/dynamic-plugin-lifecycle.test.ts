import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  DynamicPluginLoader,
  ExtensionHost,
  InMemoryDocumentStore,
  ToolRegistry,
  createAuthoringTools
} from '@inkpi/agent-core';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core: Dynamic Plugin Loader & Pre/Post Tool Lifecycle Hooks', () => {
  it('should dynamically load a plugin from directory and register custom commands and hooks', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkpi-plugin-test-'));
    const pluginCode = `
      export default function activate(api) {
        api.registerCommand('novel-stats', () => '42 chapters written');
        api.registerToolHooks({
          beforeToolCall: async (event) => {
            if (event.toolName === 'write_draft' && String(event.parameters.content).includes('违禁涉暴')) {
              return { block: true, reason: '检测到违禁词汇，禁止落笔。' };
            }
            return { block: false };
          },
          afterToolCall: async (event) => {
            if (event.toolName === 'write_draft') {
              const originalText = event.result.content && event.result.content[0] ? event.result.content[0].text : '';
              return {
                content: [{ type: 'text', text: '【审核通过】' + originalText }]
              };
            }
          }
        });
      }
    `;
    fs.writeFileSync(path.join(tempDir, 'authoring-guard.mjs'), pluginCode);

    try {
      const host = new ExtensionHost();
      const loader = new DynamicPluginLoader(host);
      const summary = await loader.loadFromDirectory(tempDir);

      expect(summary.loaded).toContain('authoring-guard.mjs');
      expect(summary.failed.length).toBe(0);

      // 验证命令已动态挂载
      const cmd = host.getCommand('novel-stats');
      expect(cmd).toBeDefined();
      expect(await cmd.execute()).toBe('42 chapters written');

      // 验证 PreToolUse 钩子生效（敏感词阻断）
      const blockedRes = await host.executeBeforeToolCall({
        toolCallId: 'call_test_1',
        toolName: 'write_draft',
        parameters: { content: '包含违禁涉暴文字' }
      });
      expect(blockedRes.block).toBe(true);
      expect(blockedRes.reason).toContain('检测到违禁词汇');

      // 验证普通内容放行
      const passRes = await host.executeBeforeToolCall({
        toolCallId: 'call_test_2',
        toolName: 'write_draft',
        parameters: { content: '第一章 纯净无暇的开篇' }
      });
      expect(passRes.block).toBe(false);

      // 验证 PostToolUse 钩子生效（结果包装与质检）
      const afterRes = await host.executeAfterToolCall({
        toolCallId: 'call_test_2',
        toolName: 'write_draft',
        parameters: { content: '第一章 纯净无暇的开篇' },
        result: {
          content: [{ type: 'text', text: 'Written 100 chars' }]
        },
        isError: false
      });
      expect(afterRes?.content?.[0]).toEqual({
        type: 'text',
        text: '【审核通过】Written 100 chars'
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('should handle non-existent directory gracefully without errors', async () => {
    const host = new ExtensionHost();
    const loader = new DynamicPluginLoader(host);
    const summary = await loader.loadFromDirectory('/non/existent/path/for/inkpi/plugins');
    expect(summary.loaded.length).toBe(0);
    expect(summary.failed.length).toBe(0);
  });
});
