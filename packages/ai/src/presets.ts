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
  },
  'mock-test': {
    id: 'mock-model-v1',
    name: 'Faux Test Model',
    provider: 'faux',
    supportsThinking: true,
    temperature: 0.0,
    fauxScript: {
      text: 'Faux test response'
    }
  }
};




export function getModelPreset(name: string): ModelConfig {
  const preset = MODEL_PRESETS[name];
  if (!preset) {
    throw new Error(`Unknown model preset '${name}'. Register or configure a model explicitly.`);
  }
  return { ...preset };
}
