export interface SerializedSemanticBlock {
  id: string;
  type: string;
  text: string;
  from: number;
  to: number;
}

export interface SerializedNeighboringDocument {
  documentId: string;
  revision: number;
  text: string;
}

/**
 * Protocol-neutral shape accepted from Desktop at the daemon boundary.
 * Creative Domain types stay on Desktop; the daemon validates only the
 * serialized fields it projects into generic context fragments.
 */
export interface SerializedCreativeContext {
  documentId: string;
  revision: number;
  text: string;
  selectionText: string;
  blocks: SerializedSemanticBlock[];
  neighboringDocuments: SerializedNeighboringDocument[];
  storyContext?: Record<string, unknown>;
  projectRevision?: number;
  fingerprint: string;
}

export function isSerializedCreativeContext(value: unknown): value is SerializedCreativeContext {
  if (!isRecord(value)) return false;
  if (
    typeof value.documentId !== 'string' ||
    typeof value.text !== 'string' ||
    typeof value.selectionText !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    !isRevision(value.revision) ||
    !Array.isArray(value.blocks) ||
    !value.blocks.every(isSerializedSemanticBlock) ||
    !Array.isArray(value.neighboringDocuments) ||
    !value.neighboringDocuments.every(isSerializedNeighboringDocument)
  ) {
    return false;
  }
  if (value.projectRevision !== undefined && !isRevision(value.projectRevision)) return false;
  return value.storyContext === undefined || isRecord(value.storyContext);
}

function isSerializedSemanticBlock(value: unknown): value is SerializedSemanticBlock {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.text === 'string' &&
    typeof value.from === 'number' &&
    Number.isFinite(value.from) &&
    typeof value.to === 'number' &&
    Number.isFinite(value.to) &&
    value.from >= 0 &&
    value.to >= value.from
  );
}

function isSerializedNeighboringDocument(value: unknown): value is SerializedNeighboringDocument {
  if (!isRecord(value)) return false;
  return typeof value.documentId === 'string' && isRevision(value.revision) && typeof value.text === 'string';
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
