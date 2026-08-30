import type { ModelConfig } from '@inkpi/protocol';
import { ModelRegistry, type ModelMetadata } from './model-registry.js';
import { getModelPreset } from '@inkpi/ai';

export type NovelTaskScope = 'drafting' | 'reasoning' | 'polishing' | 'linting' | 'fast-ghost';

export class ScopedModelResolver {
  private registry: ModelRegistry;
  private scopeMappings = new Map<NovelTaskScope, string>();

  constructor(registry?: ModelRegistry) {
    this.registry = registry || new ModelRegistry();
    this.initDefaultMappings();
  }

  private initDefaultMappings(): void {
    this.scopeMappings.set('drafting', 'creative-pro');
    this.scopeMappings.set('reasoning', 'deep-reasoning');
    this.scopeMappings.set('polishing', 'creative-pro');
    this.scopeMappings.set('linting', 'fast-draft');
    this.scopeMappings.set('fast-ghost', 'local-offline');
  }

  public setScopeMapping(scope: NovelTaskScope, modelIdOrAlias: string): void {
    this.scopeMappings.set(scope, modelIdOrAlias);
  }

  /**
   * 根据具体写作任务场景，智能解析最佳模型配置 (1:1 对标 repos/pi ScopedModelResolver)
   */
  public resolveForTask(scope: NovelTaskScope): ModelConfig {
    const targetAlias = this.scopeMappings.get(scope) || 'creative-pro';
    const metadata = this.registry.get(targetAlias);

    if (metadata) {
      return metadata.model;
    }

    return getModelPreset(targetAlias);
  }

  public getRegistry(): ModelRegistry {
    return this.registry;
  }
}
