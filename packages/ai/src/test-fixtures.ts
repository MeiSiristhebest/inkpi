import { registerModelPreset } from './presets.js';
import { fauxProvider } from './providers.js';
import { registerProvider } from './providers.js';
/**
 * 测试夹具安装器（仅用于测试环境，禁止在生产路径中调用）。
 *
 * 设计意图：原先 `mock-test` 预设与 `faux` provider 被自动注册进生产注册表，
 * 导致「未配置模型时静默回落到返回固定字符串的假模型」。
 * 现在两者不再默认存在于生产路径，改由本模块在测试 setup 中显式安装，
 * 把「是否启用假模型」这个决定权交还给测试，而非隐式生效。
 */
import type { ModelConfig } from './types.js';

const MOCK_TEST_PRESET: ModelConfig = {
  id: 'mock-model-v1',
  name: 'Faux Test Model',
  provider: 'faux',
  supportsThinking: true,
  temperature: 0.0,
  fauxScript: {
    text: 'Faux test response',
    taskResponses: {
      'creative.continue': { text: 'packaged vertical slice continuation' },
      'creative.rewrite': {
        text: JSON.stringify({ from: 0, to: 6, text: '雨停后只剩冷灯。' })
      },
      'narrative.continuity.audit': {
        text: JSON.stringify([
          {
            id: 'packaged-continuity-finding',
            severity: 'warning',
            description: 'Packaged continuity finding.'
          }
        ])
      },
      'narrative.deep.reason': {
        text: JSON.stringify({
          answer: 'Keep the cold-light motif.',
          assumptions: ['The scene remains after the rain.'],
          alternatives: ['Change the motif to warm light.'],
          risks: ['A tonal shift may weaken continuity.']
        })
      },
      'narrative.project.distill': {
        text: JSON.stringify({
          summary: 'A character pauses after the rain.',
          entities: [{ id: 'packaged-character', kind: 'character', name: '她' }],
          events: [{ id: 'packaged-event', type: 'pause', description: 'She does not look back.' }],
          promises: [{ id: 'packaged-promise', statement: 'The cold light remains.', status: 'open' }],
          confidence: 0.9
        })
      }
    }
  }
};

let installed = false;

/**
 * 注册测试专用的 faux provider 与 mock-test 预设。
 * 幂等：重复调用安全。仅应在测试 setup 或显式标注的开发冒烟脚本中调用。
 */
export function installTestDoubles(): void {
  if (installed) return;
  installed = true;
  registerProvider('faux', fauxProvider);
  registerModelPreset('mock-test', MOCK_TEST_PRESET);
}
