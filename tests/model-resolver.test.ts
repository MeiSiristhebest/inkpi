import { describe, it, expect } from 'vitest';
import { ModelRegistry, ScopedModelResolver } from '@inkpi/agent-core';

describe('@inkpi/agent-core -> Scoped Model Resolver & Registry (1:1 Ported from repos/pi)', () => {
  it('should register models, resolve aliases, and route tasks to specialized model configurations', () => {
    const registry = new ModelRegistry();

    // Register a custom model
    registry.register({
      model: {
        id: 'qwen-max-custom',
        name: 'Qwen Max Custom',
        provider: 'custom',
        supportsThinking: true,
        temperature: 0.8
      },
      aliases: ['qwen-custom', 'qwen-fast'],
      capabilities: {
        thinking: true,
        tools: true,
        vision: false
      }
    });

    expect(registry.get('qwen-custom')?.model.id).toBe('qwen-max-custom');
    expect(registry.get('qwen-fast')?.model.id).toBe('qwen-max-custom');

    const resolver = new ScopedModelResolver(registry);

    // 1. Task: drafting -> routes to creative-pro (DeepSeek Chat)
    const draftModel = resolver.resolveForTask('drafting');
    expect(draftModel.id).toBe('deepseek-chat');

    // 2. Task: reasoning -> routes to deep-reasoning (DeepSeek Reasoner with thinking)
    const reasonModel = resolver.resolveForTask('reasoning');
    expect(reasonModel.supportsThinking).toBe(true);

    // 3. Custom routing override
    resolver.setScopeMapping('drafting', 'qwen-custom');
    const customDraft = resolver.resolveForTask('drafting');
    expect(customDraft.id).toBe('qwen-max-custom');
  });
});
