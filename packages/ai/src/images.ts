import { getHttpClient } from './http-client.js';

export interface ImageGenerationOptions {
  /**
   * 提示词，如 "中国风古典小说封面，青山绿水，一叶扁舟"
   */
  prompt: string;
  /**
   * 模型标识，默认可从 provider 中推导（如 dall-e-3、flux-schnell、recraft-v3 等）
   */
  model?: string;
  /**
   * 图像尺寸，如 "1024x1024", "1792x1024", "1024x1792" (书封面竖版)
   */
  size?: string;
  /**
   * 图像品质，如 "standard" | "hd"
   */
  quality?: 'standard' | 'hd';
  /**
   * 风格设定，如 "vivid" | "natural"
   */
  style?: 'vivid' | 'natural';
  /**
   * 图像格式，默认 'url'，亦支持 'b64_json'
   */
  responseFormat?: 'url' | 'b64_json';
  /**
   * 生成张数，默认 1
   */
  n?: number;
  /**
   * 自定义 API Key（若未提供则取环境变量）
   */
  apiKey?: string;
  /**
   * 自定义端点地址（支持 OpenRouter、第三方代理或自建 ComfyUI/SD）
   */
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface GeneratedImageItem {
  url?: string;
  b64Json?: string;
  revisedPrompt?: string;
}

export interface ImageGenerationResult {
  created: number;
  data: GeneratedImageItem[];
}

export type ImageProviderHandler = (options: ImageGenerationOptions) => Promise<ImageGenerationResult>;

const imageProviderRegistry = new Map<string, ImageProviderHandler>();

/**
 * 通用 OpenAI 兼容生图适配器（原生支持 OpenAI DALL-E 3、OpenRouter、SiliconFlow、智谱 CogView 等）
 */
export async function openAiCompatibleImageProvider(options: ImageGenerationOptions): Promise<ImageGenerationResult> {
  const baseUrl = options.baseUrl || process.env.IMAGE_BASE_URL || 'https://api.openai.com/v1';
  const apiKey = options.apiKey || process.env.IMAGE_API_KEY || process.env.OPENAI_API_KEY || '';

  if (!apiKey) {
    throw new Error('Missing API key for image generation. Set options.apiKey or OPENAI_API_KEY/IMAGE_API_KEY.');
  }

  const endpoint = `${baseUrl.replace(/\/+$/, '')}/images/generations`;
  const bodyPayload: Record<string, unknown> = {
    prompt: options.prompt,
    model: options.model || 'dall-e-3',
    n: options.n ?? 1,
    size: options.size ?? '1024x1024',
    quality: options.quality ?? 'standard',
    response_format: options.responseFormat ?? 'url'
  };

  if (options.style) {
    bodyPayload.style = options.style;
  }

  const response = await getHttpClient().fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(bodyPayload),
    signal: options.signal
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new Error(`Image generation failed (${response.status} ${response.statusText}): ${errorBody.slice(0, 200)}`);
  }

  const json = (await response.json()) as any;
  const items: GeneratedImageItem[] = (json.data || []).map((item: any) => ({
    url: item.url,
    b64Json: item.b64_json,
    revisedPrompt: item.revised_prompt
  }));

  return {
    created: json.created || Date.now(),
    data: items
  };
}

// 默认注册核心生图驱动
imageProviderRegistry.set('openai', openAiCompatibleImageProvider);
imageProviderRegistry.set('openrouter', openAiCompatibleImageProvider);

export function registerImageProvider(name: string, handler: ImageProviderHandler): void {
  imageProviderRegistry.set(name, handler);
}

export function getImageProvider(name: string): ImageProviderHandler {
  const handler = imageProviderRegistry.get(name);
  if (!handler) {
    throw new Error(`Image provider '${name}' is not registered.`);
  }
  return handler;
}

/**
 * 核心图像生成入口函数：支持书封面、插图等创作场景
 */
export async function generateImage(
  options: ImageGenerationOptions,
  providerName = 'openai'
): Promise<ImageGenerationResult> {
  const handler = getImageProvider(providerName);
  return handler(options);
}
