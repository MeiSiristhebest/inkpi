import type { AgentMessage, AssistantMessageEvent } from '@inkpi/protocol';
import type { ModelCatalogV2 } from './catalog-v2.js';
import type { ClassificationCandidate, ClassificationResult } from './classification.js';
import { classifyText } from './classification.js';
import { type ImageGenerationOptions, type ImageGenerationResult, generateImage } from './images.js';
import { type ModelCredentialResolver, resolveModelCredential } from './model-credentials.js';
import type { EventStream, StreamOptions } from './types.js';

export interface ChatModelOperationRequest {
  operation: 'chat';
  model: string;
  messages: AgentMessage[];
  options?: StreamOptions;
}

export interface ClassifyModelOperationRequest {
  operation: 'classify';
  model: string;
  text: string;
  candidates: readonly ClassificationCandidate[];
  signal?: AbortSignal;
}

export interface ImageModelOperationRequest {
  operation: 'image';
  model: string;
  options: Omit<ImageGenerationOptions, 'model' | 'apiKey' | 'baseUrl'>;
}

export type ModelOperationRequest =
  | ChatModelOperationRequest
  | ClassifyModelOperationRequest
  | ImageModelOperationRequest;

export interface ModelOperationExecutorOptions {
  /** Host credential store hook. The route descriptor contains no secret values. */
  credentialResolver?: ModelCredentialResolver;
}

export function executeModelOperation(
  catalog: ModelCatalogV2,
  request: ChatModelOperationRequest,
  options?: ModelOperationExecutorOptions
): Promise<EventStream<AssistantMessageEvent>>;
export function executeModelOperation(
  catalog: ModelCatalogV2,
  request: ClassifyModelOperationRequest,
  options?: ModelOperationExecutorOptions
): Promise<ClassificationResult>;
export function executeModelOperation(
  catalog: ModelCatalogV2,
  request: ImageModelOperationRequest,
  options?: ModelOperationExecutorOptions
): Promise<ImageGenerationResult>;
/** Execute chat, classify, and image operations through one catalog route and credential boundary. */
export async function executeModelOperation(
  catalog: ModelCatalogV2,
  request: ModelOperationRequest,
  options: ModelOperationExecutorOptions = {}
): Promise<EventStream<AssistantMessageEvent> | ClassificationResult | ImageGenerationResult> {
  if (request.operation === 'classify') {
    return classifyText({
      catalog,
      model: request.model,
      text: request.text,
      candidates: request.candidates,
      signal: request.signal,
      credentialResolver: options.credentialResolver
    });
  }

  if (request.operation === 'chat') {
    const executable = catalog.resolveExecutableOperation(request.model, 'chat');
    const apiKey = await resolveModelCredential(executable.route, options.credentialResolver);
    const model = apiKey === undefined ? executable.config : { ...executable.config, apiKey };
    return executable.handler(model, request.messages, request.options);
  }

  const resolved = catalog.resolveOperation(request.model, 'image');
  const apiKey = await resolveModelCredential(resolved.route, options.credentialResolver);
  return generateImage(
    {
      ...request.options,
      model: resolved.config.id,
      ...(resolved.config.baseUrl ? { baseUrl: resolved.config.baseUrl } : {}),
      ...(apiKey !== undefined ? { apiKey } : {})
    },
    resolved.route.provider
  );
}
