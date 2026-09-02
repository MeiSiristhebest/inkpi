import type { ModelConfig } from '@inkpi/protocol';
import { type ModelMetadata, ModelRegistry } from './model-registry.js';

export type TaskScope = 'drafting' | 'reasoning' | 'polishing' | 'linting' | 'fast-ghost' | string;
export type NovelTaskScope = TaskScope;

export interface ScopedModelResolverOptions {
  scopeMappings?: Record<string, string>;
  fallbackModel?: string;
}

export class ScopedModelResolver {
  private registry: ModelRegistry;
  private scopeMappings = new Map<TaskScope, string>();
  private fallbackModel?: string;

  constructor(registry?: ModelRegistry, options: ScopedModelResolverOptions = {}) {
    this.registry = registry || new ModelRegistry();
    this.fallbackModel = options.fallbackModel;
    for (const [scope, model] of Object.entries(options.scopeMappings || {})) {
      this.scopeMappings.set(scope, model);
    }
  }

  public setScopeMapping(scope: TaskScope, modelIdOrAlias: string): void {
    this.scopeMappings.set(scope, modelIdOrAlias);
  }

  /**
   * 根据具体任务场景，智能解析最佳模型配置
   */
  public resolveForTask(scope: TaskScope): ModelConfig {
    const targetAlias = this.scopeMappings.get(scope) || this.fallbackModel;
    if (!targetAlias) {
      throw new Error(`No model mapping configured for task scope '${scope}'.`);
    }
    const metadata = this.registry.get(targetAlias);

    if (metadata) {
      return metadata.model;
    }

    throw new Error(`Model '${targetAlias}' is not registered for task scope '${scope}'.`);
  }

  public getRegistry(): ModelRegistry {
    return this.registry;
  }
}
