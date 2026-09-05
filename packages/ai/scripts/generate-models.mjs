#!/usr/bin/env node

/**
 * InkPi 模型目录全自动抓取、水合与类型生成引擎 (1:1 落地 @earendil-works/pi-ai 架构)
 * 具备从 OpenRouter / 远程端点实时拉取最新模型、定价（Input/Output/Cache）、上下文窗口（Context Window）、
 * 视觉支持（Vision）、思考链（Thinking/Reasoning）与 Tool Calls 特性，并输出类型安全代码与 JSON 数据集。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.join(__dirname, '..');

const args = process.argv.slice(2);
const isStrict = args.includes('--strict');
const isDataOnly = args.includes('--data-only');
const isFromJson = args.includes('--from-json');

/**
 * 从 OpenRouter 实时抓取全量最新模型目录
 */
async function fetchOpenRouterModels() {
  console.log('📡 [Hydration] Fetching live model definitions from OpenRouter API...');
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const res = await fetch('https://openrouter.ai/api/v1/models', {
      signal: controller.signal,
      headers: {
        'User-Agent': 'InkPi-Model-Hydrator/1.0.0'
      }
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`OpenRouter HTTP ${res.status}: ${res.statusText}`);
    }

    const data = await res.json();
    if (!data?.data || !Array.isArray(data.data)) {
      throw new Error('Invalid OpenRouter response format');
    }

    const models = [];

    for (const item of data.data) {
      const rawId = item.id || '';
      const parts = rawId.split('/');
      const rawProvider = parts.length > 1 ? parts[0] : 'custom';
      
      // 归一化 Provider
      let provider = rawProvider;
      if (rawProvider.includes('anthropic')) provider = 'claude';
      else if (rawProvider.includes('openai')) provider = 'openai';
      else if (rawProvider.includes('google')) provider = 'gemini';
      else if (rawProvider.includes('deepseek')) provider = 'deepseek';
      else if (rawProvider.includes('groq') || rawProvider.includes('meta-llama')) provider = 'groq';
      else if (rawProvider.includes('mistral')) provider = 'mistral';
      else if (rawProvider.includes('x-ai')) provider = 'xai';
      else if (rawProvider.includes('qwen') || rawProvider.includes('alibaba')) provider = 'qwen';

      const promptPrice = parseFloat(item.pricing?.prompt || '0') * 1_000_000;
      const completionPrice = parseFloat(item.pricing?.completion || '0') * 1_000_000;
      const cacheReadPrice = item.pricing?.input_cache_read
        ? parseFloat(item.pricing.input_cache_read) * 1_000_000
        : undefined;
      const cacheWritePrice = item.pricing?.input_cache_write
        ? parseFloat(item.pricing.input_cache_write) * 1_000_000
        : undefined;

      const supportsThinking = Boolean(
        item.supported_parameters?.includes('reasoning') ||
        item.supported_parameters?.includes('include_reasoning') ||
        item.reasoning ||
        rawId.toLowerCase().includes('r1') ||
        rawId.toLowerCase().includes('o1') ||
        rawId.toLowerCase().includes('o3') ||
        rawId.toLowerCase().includes('thinking') ||
        (item.name || '').toLowerCase().includes('r1') ||
        (item.name || '').toLowerCase().includes('reasoner') ||
        (item.name || '').toLowerCase().includes('thinking')
      );


      const supportsTools = Boolean(
        item.supported_parameters?.includes('tools') ||
        item.supported_parameters?.includes('tool_choice') ||
        item.tool_call === true
      );

      const supportsVision = Boolean(
        item.architecture?.input_modalities?.includes('image') ||
        item.architecture?.modality?.includes('image') ||
        item.id?.includes('vision') ||
        item.id?.includes('vl') ||
        item.id?.includes('4o')
      );

      models.push({
        id: item.id,
        name: item.name || item.id,
        provider,
        contextWindow: item.context_length || item.top_provider?.context_length || 32768,
        maxTokens: item.top_provider?.max_completion_tokens || 8192,
        supportsThinking,
        supportsTools,
        supportsVision,
        cost: {
          inputPerMillionUsd: Math.round(promptPrice * 1000) / 1000,
          outputPerMillionUsd: Math.round(completionPrice * 1000) / 1000,
          ...(cacheReadPrice !== undefined ? { cacheReadPerMillionUsd: Math.round(cacheReadPrice * 1000) / 1000 } : {}),
          ...(cacheWritePrice !== undefined ? { cacheWritePerMillionUsd: Math.round(cacheWritePrice * 1000) / 1000 } : {})
        },
        description: item.description?.slice(0, 150) || undefined
      });
    }

    console.log(`✨ Successfully retrieved and parsed ${models.length} real-time models from OpenRouter.`);
    return models;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn(`⚠️ [Hydration Notice] Remote fetch failed (${err.message}). Using built-in offline core registry.`);
    return [];
  }
}

/**
 * 离线核心标准模型基准表（保障断网环境下的 100% 确定性编译）
 */
const OFFLINE_CORE_MODELS = [
  {
    id: 'deepseek/deepseek-chat',
    name: 'DeepSeek V3',
    provider: 'deepseek',
    contextWindow: 65536,
    maxTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsVision: false,
    cost: { inputPerMillionUsd: 0.14, outputPerMillionUsd: 0.28, cacheReadPerMillionUsd: 0.014 },
    description: 'DeepSeek V3 671B MoE 基础高通量大模型'
  },
  {
    id: 'deepseek/deepseek-r1',
    name: 'DeepSeek R1',
    provider: 'deepseek',
    contextWindow: 65536,
    maxTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: false,
    cost: { inputPerMillionUsd: 0.55, outputPerMillionUsd: 2.19, cacheReadPerMillionUsd: 0.14 },
    description: 'DeepSeek R1 原生深度思考链推理大模型'
  },
  {
    id: 'anthropic/claude-3.7-sonnet',
    name: 'Claude 3.7 Sonnet',
    provider: 'claude',
    contextWindow: 200000,
    maxTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    cost: { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0, cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75 },
    description: 'Anthropic 混合推理旗舰模型'
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'claude',
    contextWindow: 200000,
    maxTokens: 8192,
    supportsThinking: false,
    supportsTools: true,
    supportsVision: true,
    cost: { inputPerMillionUsd: 3.0, outputPerMillionUsd: 15.0, cacheReadPerMillionUsd: 0.3, cacheWritePerMillionUsd: 3.75 },
    description: 'Anthropic 主力长文本与逻辑创作模型'
  },
  {
    id: 'openai/gpt-4o',
    name: 'GPT-4o',
    provider: 'openai',
    contextWindow: 128000,
    maxTokens: 16384,
    supportsThinking: false,
    supportsTools: true,
    supportsVision: true,
    cost: { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10.0, cacheReadPerMillionUsd: 1.25 },
    description: 'OpenAI 旗舰全模态模型'
  },
  {
    id: 'openai/o3-mini',
    name: 'OpenAI o3-mini',
    provider: 'openai',
    contextWindow: 200000,
    maxTokens: 100000,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: false,
    cost: { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4, cacheReadPerMillionUsd: 0.55 },
    description: 'OpenAI 高速科学与代码推理模型'
  },
  {
    id: 'google/gemini-2.5-pro',
    name: 'Gemini 2.5 Pro',
    provider: 'gemini',
    contextWindow: 1000000,
    maxTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    cost: { inputPerMillionUsd: 1.25, outputPerMillionUsd: 5.0, cacheReadPerMillionUsd: 0.31 },
    description: 'Google 百万上下文原生推理模型'
  },
  {
    id: 'google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'gemini',
    contextWindow: 1000000,
    maxTokens: 8192,
    supportsThinking: true,
    supportsTools: true,
    supportsVision: true,
    cost: { inputPerMillionUsd: 0.1, outputPerMillionUsd: 0.4, cacheReadPerMillionUsd: 0.025 },
    description: 'Google 超高速多模态与长上下文轻量模型'
  },
  {
    id: 'ollama/qwen2.5:14b',
    name: 'Qwen 2.5 14B (Ollama)',
    provider: 'ollama',
    contextWindow: 32768,
    maxTokens: 4096,
    supportsThinking: false,
    supportsTools: true,
    supportsVision: false,
    cost: { inputPerMillionUsd: 0.0, outputPerMillionUsd: 0.0 },
    description: '本地离线隐私部署模型'
  },
];

async function main() {
  // --from-json：离线模式，直接复用现有 models-data.json 只再生成 TypeScript 目录。
  // 用于对数据集做精准修订（移除/新增条目）后同步生成物，而不触发远程抓取造成全量漂移。
  if (isFromJson) {
    console.log('[InkPi Model Hydrator] --from-json: regenerating TypeScript catalog from existing models-data.json...');
    const jsonPath = path.join(packageRoot, 'src', 'models-data.json');
    const parsed = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error('models-data.json is empty or malformed.');
    }
    const allModels = parsed.filter((model) => {
      const id = String(model.id || '').toLowerCase();
      return model.provider !== 'faux' && !id.startsWith('mock/');
    });
    console.log(`📦 Loaded ${allModels.length} models from existing dataset.`);
    writeTypeScriptCatalog(allModels);
    return;
  }

  console.log('[InkPi Model Hydrator] Starting full dynamic model discovery & code generation...');

  const liveModels = await fetchOpenRouterModels();
  
  // 合并模型列表，在线抓取优先，离线核心兜底并去重
  const modelMap = new Map();
  for (const m of OFFLINE_CORE_MODELS) {
    modelMap.set(m.id, m);
    // 同时注册简写别名（如 deepseek-chat -> deepseek/deepseek-chat）
    const shortId = m.id.includes('/') ? m.id.split('/')[1] : m.id;
    if (shortId && !modelMap.has(shortId)) {
      modelMap.set(shortId, { ...m, id: shortId });
    }
  }

  for (const m of liveModels) {
    modelMap.set(m.id, m);
    const shortId = m.id.includes('/') ? m.id.split('/')[1] : m.id;
    if (shortId && !modelMap.has(shortId)) {
      modelMap.set(shortId, { ...m, id: shortId });
    }
  }

  // Faux/test transports belong to test fixtures, never to the production catalog.
  const allModels = Array.from(modelMap.values()).filter((model) => {
    const id = String(model.id || '').toLowerCase();
    return model.provider !== 'faux' && !id.startsWith('mock/');
  });
  console.log(`📦 Consolidated dynamic catalog size: ${allModels.length} models across all providers.`);

  const dataDir = path.join(packageRoot, 'src');
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  // 1. 写入 models-data.json
  const jsonPath = path.join(dataDir, 'models-data.json');
  fs.writeFileSync(jsonPath, JSON.stringify(allModels, null, 2), 'utf8');
  console.log(`✅ [JSON Dataset] Written: ${path.relative(packageRoot, jsonPath)}`);

  if (isDataOnly) return;

  writeTypeScriptCatalog(allModels);
}

function writeTypeScriptCatalog(allModels) {
  const dataDir = path.join(packageRoot, 'src');
  // 2. 生成 TypeScript 强类型定义
  const topModelIds = allModels.slice(0, 60).map((m) => `  | '${m.id}'`).join('\n');
  const providerTypes = Array.from(new Set(allModels.map((m) => m.provider)))
    .map((p) => `  | '${p}'`)
    .join('\n');

  const tsContent = `/**
 * AUTOGENERATED FILE - DO NOT EDIT MANUALLY
 * Generated by @inkpi/ai scripts/generate-models.mjs
 * 1:1 Aligned with @earendil-works/pi-ai Dynamic Model Catalog
 */

import type { ProviderType } from './types.js';

export type KnownModelId =
${topModelIds}
  | (string & {});

export type KnownProviderType =
${providerTypes}
  | (string & {});

export interface GeneratedModelMeta {
  id: KnownModelId;
  name: string;
  provider: ProviderType | string;
  contextWindow: number;
  maxTokens: number;
  supportsThinking: boolean;
  maxThinkingBudget?: number;
  supportsTools: boolean;
  supportsVision: boolean;
  cost: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    cacheReadPerMillionUsd?: number;
    cacheWritePerMillionUsd?: number;
  };
  description?: string;
}

export const GENERATED_MODELS: GeneratedModelMeta[] = ${JSON.stringify(allModels, null, 2)};

export function findGeneratedModel(idOrName: string): GeneratedModelMeta | undefined {
  if (!idOrName) return undefined;
  const query = idOrName.toLowerCase().trim();
  const normalizedQuery = query.replace(/[^a-z0-9]/g, '');

  return GENERATED_MODELS.find((m) => {
    const mId = (m.id || '').toLowerCase();
    const mName = (m.name || '').toLowerCase();

    if (mId === query || mName === query) return true;
    if (mId.endsWith('/' + query)) return true;

    // Canonical Aliases
    if ((query === 'deepseek-reasoner' || query === 'deepseek/deepseek-reasoner') && (mId.includes('deepseek-r1') || mId.includes('deepseek/deepseek-r1'))) return true;
    if ((query === 'deepseek-chat' || query === 'deepseek/deepseek-chat') && (mId.includes('deepseek-chat') || mId.includes('deepseek-v3'))) return true;
    if (query.includes('claude-3-7') && mId.includes('claude-3.7')) return true;
    if (query.includes('claude-3-5') && mId.includes('claude-3.5')) return true;

    const normId = mId.replace(/[^a-z0-9]/g, '');
    const normName = mName.replace(/[^a-z0-9]/g, '');
    return (normId.length > 3 && normId.includes(normalizedQuery)) || (normName.length > 3 && normName.includes(normalizedQuery));
  });

}

export function listGeneratedModelsByProvider(provider: string): GeneratedModelMeta[] {
  return GENERATED_MODELS.filter((m) => m.provider === provider);
}

`;

  const tsPath = path.join(dataDir, 'models.generated.ts');
  fs.writeFileSync(tsPath, tsContent, 'utf8');
  console.log(`✅ [TypeScript Types] Written: ${path.relative(packageRoot, tsPath)}`);
}

main().catch((err) => {
  console.error('❌ Error during model hydration:', err);
  process.exit(1);
});
