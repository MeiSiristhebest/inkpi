import type { ThinkingLevel } from '@inkpi/protocol';
import type { ModelConfig, ProviderType } from './types.js';

export interface ModelCatalogEntry {
  id: string;
  name: string;
  provider: ProviderType;
  contextWindow: number;
  maxTokens: number;
  supportsThinking: boolean;
  supportsTools: boolean;
  cost: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    cacheReadPerMillionUsd?: number;
    cacheWritePerMillionUsd?: number;
  };
  description?: string;
}

export const KNOWN_MODELS: ModelCatalogEntry[] = [
  {
    id: 'deepseek-chat',
    name: 'DeepSeek V3',
    provider: 'deepseek',
    contextWindow: 65536,
    maxTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    cost: { inputPerMillionUsd: 0.14, outputPerMillionUsd: 0.28, cacheReadPerMillionUsd: 0.014 },
    description: 'High throughput general text generation with prompt caching support'
  },
  {
    id: 'deepseek-reasoner',
    name: 'DeepSeek R1',
    provider: 'deepseek',
    contextWindow: 65536,
    maxTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    cost: { inputPerMillionUsd: 0.55, outputPerMillionUsd: 2.19, cacheReadPerMillionUsd: 0.14 },
    description: 'Deep reasoning model with thinking tokens output'
  },
  {
    id: 'claude-3-7-sonnet',
    name: 'Claude 3.7 Sonnet',
    provider: 'claude',
    contextWindow: 200000,
    maxTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    cost: { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0, cacheReadPerMillionUsd: 0.3 },
    description: 'Anthropic flagship model with extended thinking and prompt caching'
  },
  {
    id: 'claude-3-5-haiku',
    name: 'Claude 3.5 Haiku',
    provider: 'claude',
    contextWindow: 200000,
    maxTokens: 4096,
    supportsThinking: false,
    supportsTools: true,
    cost: { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4.0, cacheReadPerMillionUsd: 0.08 },
    description: 'Fast, lightweight low-latency model'
  },
  {
    id: 'gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    maxTokens: 4096,
    supportsThinking: false,
    supportsTools: true,
    cost: { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10.0, cacheReadPerMillionUsd: 1.25 },
    description: 'OpenAI flagship multimodal model'
  },
  {
    id: 'o3-mini',
    name: 'o3-mini',
    provider: 'openai',
    contextWindow: 200000,
    maxTokens: 16384,
    supportsThinking: true,
    supportsTools: true,
    cost: { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4, cacheReadPerMillionUsd: 0.55 },
    description: 'OpenAI reasoning model with variable reasoning effort'
  },
  {
    id: 'gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'gemini',
    contextWindow: 1000000,
    maxTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    cost: { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5.0, cacheReadPerMillionUsd: 0.31 },
    description: 'Google long-context model with native reasoning support'
  },
  {
    id: 'qwen2.5:14b',
    name: 'Qwen 2.5 14B',
    provider: 'ollama',
    contextWindow: 32768,
    maxTokens: 4096,
    supportsThinking: false,
    supportsTools: false,
    cost: { inputPerMillionUsd: 0.0, outputPerMillionUsd: 0.0 },
    description: 'Local offline inference model via Ollama'
  },
  {
    id: 'mock-model-v1',
    name: 'Faux Test Model',
    provider: 'custom',
    contextWindow: 32768,
    maxTokens: 4096,
    supportsThinking: true,
    supportsTools: true,
    cost: { inputPerMillionUsd: 0.0, outputPerMillionUsd: 0.0 },
    description: 'Deterministic testing and verification model'
  }
];

export function getThinkingBudgetForLevel(level: ThinkingLevel): number {
  switch (level) {
    case 'none':
      return 0;
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 16384;
    case 'xhigh':
      return 24576;
    case 'max':
      return 32768;
    default:
      return 0;
  }
}

export function findModelInCatalog(idOrName: string): ModelCatalogEntry | undefined {
  const query = idOrName.toLowerCase().trim();
  return KNOWN_MODELS.find(
    (m) => m.id.toLowerCase() === query || m.name.toLowerCase().includes(query)
  );
}

export function modelCatalogEntryToConfig(entry: ModelCatalogEntry): ModelConfig {
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    supportsThinking: entry.supportsThinking,
    maxTokens: entry.maxTokens,
    supportsPromptCache: Boolean(entry.cost.cacheReadPerMillionUsd !== undefined)
  };
}

/**
 * 动态模型目录管理器 (1:1 对标 repos/pi ModelCatalogManager)
 */
export class ModelCatalogManager {
  private models = new Map<string, ModelCatalogEntry>();

  constructor(initialModels: ModelCatalogEntry[] = KNOWN_MODELS) {
    for (const m of initialModels) {
      this.models.set(m.id, m);
    }
  }

  public registerModel(entry: ModelCatalogEntry): void {
    this.models.set(entry.id, entry);
  }

  public unregisterModel(id: string): boolean {
    return this.models.delete(id);
  }

  public getModel(id: string): ModelCatalogEntry | undefined {
    return this.models.get(id);
  }

  public getAllModels(): ModelCatalogEntry[] {
    return Array.from(this.models.values());
  }

  public filterByProvider(provider: ProviderType): ModelCatalogEntry[] {
    return this.getAllModels().filter((m) => m.provider === provider);
  }

  public filterByCapability(capability: { thinking?: boolean; tools?: boolean }): ModelCatalogEntry[] {
    return this.getAllModels().filter((m) => {
      if (capability.thinking !== undefined && m.supportsThinking !== capability.thinking) return false;
      if (capability.tools !== undefined && m.supportsTools !== capability.tools) return false;
      return true;
    });
  }

  public async refreshCatalog(fetcher?: () => Promise<ModelCatalogEntry[]>): Promise<ModelCatalogEntry[]> {
    if (fetcher) {
      const fetched = await fetcher();
      for (const m of fetched) {
        this.models.set(m.id, m);
      }
    }
    return this.getAllModels();
  }
}
