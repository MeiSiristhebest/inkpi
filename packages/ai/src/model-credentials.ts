import type { ModelAuthenticationDescriptor, ModelRouteDescriptor } from './catalog-v2.js';
import { resolveProviderApiKeyEnv } from './providers.js';

export interface ModelCredentialContext {
  canonicalModelId: string;
  provider: string;
  authentication: ModelAuthenticationDescriptor;
}

export type ModelCredentialResolver = (
  context: ModelCredentialContext
) => string | undefined | Promise<string | undefined>;

/** Resolve credentials without storing secret values in catalog metadata. */
export async function resolveModelCredential(
  route: ModelRouteDescriptor,
  resolver?: ModelCredentialResolver
): Promise<string | undefined> {
  const context: ModelCredentialContext = {
    canonicalModelId: route.canonicalId,
    provider: route.provider,
    authentication: { ...route.authentication }
  };
  const { authentication } = context;
  if (authentication.kind === 'none') return undefined;

  const envVar =
    authentication.envVar ?? (authentication.kind === 'api-key' ? resolveProviderApiKeyEnv(route.provider) : undefined);
  let credential: string | undefined;
  const resolvedByHost = resolver !== undefined;
  if (resolver) {
    credential = await resolver(context);
  } else if (envVar) {
    credential = process.env[envVar];
  } else if (authentication.kind === 'oauth' || authentication.kind === 'custom') {
    throw new Error(
      `Model '${route.canonicalId}' uses ${authentication.kind} authentication; provide a credential resolver.`
    );
  }

  if (credential !== undefined && typeof credential !== 'string') {
    throw new Error(`Credential resolver returned an invalid credential for model '${route.canonicalId}'.`);
  }
  if (resolvedByHost && credential !== undefined && credential.trim().length === 0) {
    throw new Error(`Credential resolver returned an empty credential for model '${route.canonicalId}'.`);
  }
  if (!resolvedByHost && credential?.trim().length === 0) credential = undefined;
  if (!credential && authentication.required) {
    if (envVar) {
      throw new Error(
        `Missing credential for model '${route.canonicalId}'. Set ${envVar} or provide a credential resolver.`
      );
    }
    throw new Error(`Missing credential for model '${route.canonicalId}'. Provide a credential resolver.`);
  }
  return credential;
}
