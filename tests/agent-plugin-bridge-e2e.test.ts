import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent, DynamicPluginLoader } from '@inkpi/agent-core';
import { AssistantEventStream, getModelPreset } from '@inkpi/ai';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core: End-to-End Dynamic Plugin Lifecycle in Agent Loop', () => {
  it('should automatically bridge extension tool hooks into Agent execution loop', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inkpi-agent-plugin-'));
    const pluginsDir = path.join(tempDir, '.inkpi', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });

    // 编写一个真实敏感词风控插件
    const pluginCode = `
      export default function activate(api) {
        api.registerToolHooks({
          beforeToolCall: async (event) => {
            if (event.toolName === 'mock_author_tool' && String(event.parameters.text).includes('危险剧情')) {
              return { block: true, reason: '【风控拦截】剧情包含违规危险设定，已被拦截。', terminate: true };
            }
            return { block: false };
          },
          afterToolCall: async (event) => {
            if (event.toolName === 'mock_author_tool') {
              const originalText = event.result.content && event.result.content[0] ? event.result.content[0].text : '';
              return {
                content: [{ type: 'text', text: '【插件加固】' + originalText }]
              };
            }
          }
        });
      }
    `;
    fs.writeFileSync(path.join(pluginsDir, 'story-guard.mjs'), pluginCode);

    try {
      let callCount = 0;
      // 1. 创建 Agent，初始注册一个创作测试工具与可控流式返回
      const agent = new Agent({
        initialState: {
          model: getModelPreset('mock-test'),
          tools: [
            {
              name: 'mock_author_tool',
              description: '测试创作工具',
              parameters: {
                type: 'object',
                properties: { text: { type: 'string' } }
              },
              execute: async (_id, args: any) => ({
                content: [{ type: 'text', text: `Success: ${args.text}` }]
              })
            }
          ]
        },
        streamFn: () => {
          callCount += 1;
          const stream = new AssistantEventStream();
          if (callCount === 1) {
            stream.push({ type: 'tool_call_start', toolCallId: 'call_blocked_1', toolName: 'mock_author_tool' });
            stream.push({
              type: 'tool_call_delta',
              toolCallId: 'call_blocked_1',
              argsDelta: JSON.stringify({ text: '这是危险剧情描述' })
            });
            stream.push({
              type: 'tool_call_end',
              toolCall: {
                type: 'toolCall',
                id: 'call_blocked_1',
                name: 'mock_author_tool',
                arguments: { text: '这是危险剧情描述' }
              }
            });
          } else {
            stream.push({ type: 'text_delta', textDelta: 'done' });
          }
          stream.end();
          return stream;
        }
      });

      // 2. 动态载入插件
      const loader = new DynamicPluginLoader(agent.getExtensionHost());
      const loadRes = await loader.loadDefaultDirectories(tempDir);
      expect(loadRes.loaded).toContain('story-guard.mjs');

      // 3. 运行一轮对话，触发工具调用
      await agent.prompt('开始撰写这一段剧情');

      // 4. 断言工具执行被插件成功拦截
      const toolResultMsg = agent.state.messages.find((m) => m.role === 'toolResult');
      expect(toolResultMsg).toBeDefined();
      expect((toolResultMsg as any).isError).toBe(true);
      expect((toolResultMsg as any).content[0].text).toContain('【风控拦截】剧情包含违规危险设定');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
