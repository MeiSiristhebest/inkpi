import type { ContextProvider } from '@inkpi/agent-core';
import { stableSerialize } from '@inkpi/agent-core';
import { type SerializedCreativeContext, isSerializedCreativeContext } from './serialized-creative-context-schema.js';

/**
 * The Desktop compiler sends a JSON-safe CreativeContext inside task.input.payload.
 * These adapters keep the Runtime boundary generic: no Creative Domain type is
 * imported here, and the providers only project the serialized contract.
 */
export const SERIALIZED_CREATIVE_DOCUMENT_PROVIDER_ID = 'creative.document';
export const SERIALIZED_CREATIVE_STORY_PROVIDER_ID = 'creative.story';

export function createSerializedCreativeContextProviders(): readonly ContextProvider[] {
  return [
    {
      id: SERIALIZED_CREATIVE_DOCUMENT_PROVIDER_ID,
      bucket: 'scene',
      supports: ({ task }) => getCreativeContext(task.input.payload) !== undefined,
      provide: ({ task }) => {
        const context = getCreativeContext(task.input.payload);
        if (!context) return [];

        // Structure only: a block's text is a slice of `text` by construction on Desktop, and the
        // selection already travels as the task-input fragment. Serialising them alongside the
        // manuscript put the same chapter in the prompt three times, in a fragment too large to be
        // trimmed because trimming only reaches text fragments.
        const document = {
          documentId: context.documentId,
          revision: context.revision,
          blocks: context.blocks.map(({ id, type, from, to }) => ({ id, type, from, to })),
          neighboringDocuments: context.neighboringDocuments.map(({ documentId, revision, text }) => ({
            documentId,
            revision,
            text
          })),
          projectRevision: context.projectRevision,
          fingerprint: context.fingerprint
        };
        return [
          {
            id: `creative.document:${hash(stableSerialize(document))}`,
            source: SERIALIZED_CREATIVE_DOCUMENT_PROVIDER_ID,
            kind: 'semantic-document',
            data: document,
            priority: 800,
            dependency: 1
          },
          {
            id: `creative.document.text:${context.fingerprint}`,
            source: SERIALIZED_CREATIVE_DOCUMENT_PROVIDER_ID,
            kind: 'document-prose',
            text: context.text,
            priority: 810,
            dependency: 1
          }
        ];
      }
    },
    {
      id: SERIALIZED_CREATIVE_STORY_PROVIDER_ID,
      bucket: 'project',
      supports: ({ task }) =>
        task.contextPolicy?.includeProjectState === true &&
        getCreativeContext(task.input.payload)?.storyContext !== undefined,
      provide: ({ task }) => {
        const storyContext = getCreativeContext(task.input.payload)?.storyContext;
        if (!storyContext) return [];
        return [
          {
            id: `creative.story:${hash(stableSerialize(storyContext))}`,
            source: SERIALIZED_CREATIVE_STORY_PROVIDER_ID,
            kind: 'story-state',
            data: storyContext,
            priority: 700,
            dependency: 1
          }
        ];
      }
    }
  ];
}

function getCreativeContext(payload: unknown): SerializedCreativeContext | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const context = (payload as Record<string, unknown>).context;
  return isSerializedCreativeContext(context) ? context : undefined;
}

function hash(value: string): string {
  let result = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index);
    result = Math.imul(result, 0x01000193);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}
