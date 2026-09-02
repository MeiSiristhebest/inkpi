import type { ModelConfig } from './types.js';

export const MODEL_PRESETS: Record<string, ModelConfig> = {
  'creative-pro': {
    id: 'deepseek-chat',
    name: 'DeepSeek V3 (Creative Pro)',
    provider: 'deepseek',
    temperature: 0.8,
    topP: 0.95,
    presencePenalty: 0.4,
    frequencyPenalty: 0.3,
    maxTokens: 4096,
    supportsPromptCache: true
  },
  'creative-fast': {
    id: 'deepseek-chat',
    name: 'DeepSeek Fast Draft',
    provider: 'deepseek',
    temperature: 0.7,
    maxTokens: 1024,
    supportsPromptCache: true
  },
  'creative-local': {
    id: 'qwen2.5:14b',
    name: 'Ollama Qwen 2.5 14B (Local)',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    temperature: 0.75,
    maxTokens: 2048
  },
  'deep-reasoning': {
    id: 'deepseek-reasoner',
    name: 'DeepSeek R1 (Deep Reasoning)',
    provider: 'deepseek',
    supportsThinking: true,
    thinkingBudget: 4000,
    temperature: 0.6,
    maxTokens: 8192
  },
  'fast-draft': {
    id: 'deepseek-chat',
    name: 'DeepSeek Fast Draft',
    provider: 'deepseek',
    temperature: 0.7,
    maxTokens: 1024
  },
  'local-offline': {
    id: 'qwen2.5:14b',
    name: 'Ollama Qwen 2.5 14B',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    temperature: 0.75,
    maxTokens: 2048
  }
};

// 注意：`mock-test` 预设是测试夹具，已从生产预设表中移除。
// 它现在由 `installTestDoubles()`（test-fixtures.ts）在测试环境中显式注册，
// 避免在缺少真实模型配置时静默回落到一个返回固定字符串的假模型。

export function getModelPreset(name: string): ModelConfig {
  const preset = MODEL_PRESETS[name];
  if (!preset) {
    throw new Error(`Unknown model preset '${name}'. Register or configure a model explicitly.`);
  }
  return { ...preset };
}

/**
 * 运行时注册一个自定义模型预设（供测试夹具或动态配置使用）。
 * 生产代码不得用它来注册假模型；测试环境通过 `installTestDoubles()` 使用。
 */
export function registerModelPreset(name: string, config: ModelConfig): void {
  MODEL_PRESETS[name] = config;
}

export function hasModelPreset(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_PRESETS, name);
}
