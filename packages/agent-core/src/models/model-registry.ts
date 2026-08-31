import type { ModelConfig } from '@inkpi/protocol';
import { MODEL_PRESETS } from '@inkpi/ai';

export interface ModelMetadata {
  model: ModelConfig;
  aliases: string[];
  capabilities: {
    thinking: boolean;
    tools: boolean;
    vision: boolean;
  };
  pricingPerMillionTokens?: {
    input: number;
    output: number;
    cacheRead?: number;
  };
}

export class ModelRegistry {
  private models = new Map<string, ModelMetadata>();
  private aliasMap = new Map<string, string>();

  constructor() {
    this.initDefaultModels();
  }

  private initDefaultModels(): void {
    for (const [presetKey, model] of Object.entries(MODEL_PRESETS)) {
      this.register({
        model: model as any,
        aliases: [presetKey, (model as any).id],
        capabilities: {
          thinking: (model as any).supportsThinking ?? false,
          tools: true,
          vision: false
        }
      });
    }
  }

  public register(meta: ModelMetadata): void {
    this.models.set(meta.model.id, meta);
    for (const alias of meta.aliases) {
      this.aliasMap.set(alias.toLowerCase(), meta.model.id);
    }
  }

  public get(idOrAlias: string): ModelMetadata | undefined {
    const direct = this.models.get(idOrAlias);
    if (direct) return direct;

    const resolvedId = this.aliasMap.get(idOrAlias.toLowerCase());
    if (resolvedId) {
      return this.models.get(resolvedId);
    }
    return undefined;
  }

  public getAll(): ModelMetadata[] {
    return Array.from(this.models.values());
  }

  public filterByCapability(capability: { thinking?: boolean; tools?: boolean; vision?: boolean }): ModelMetadata[] {
    return this.getAll().filter((m) => {
      if (capability.thinking !== undefined && m.capabilities.thinking !== capability.thinking) return false;
      if (capability.tools !== undefined && m.capabilities.tools !== capability.tools) return false;
      if (capability.vision !== undefined && m.capabilities.vision !== capability.vision) return false;
      return true;
    });
  }

  public unregister(idOrAlias: string): boolean {
    const resolvedId = this.aliasMap.get(idOrAlias.toLowerCase()) || idOrAlias;
    return this.models.delete(resolvedId);
  }
}

