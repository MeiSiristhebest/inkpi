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

export interface SerializedReferenceExcerpt {
  sourceId: string;
  sourceTitle: string;
  start: number;
  end: number;
  text: string;
}

export interface SerializedReferenceMaterials {
  excerpts: SerializedReferenceExcerpt[];
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
  /** Only explicitly selected, bounded passages are serialized for Runtime prompt context. */
  referenceMaterials?: SerializedReferenceMaterials;
  projectRevision?: number;
  fingerprint: string;
}

const MAX_REFERENCE_EXCERPTS = 32;
const MAX_REFERENCE_CHARACTERS = 20_000;

export function isSerializedReferenceMaterials(value: unknown): value is SerializedReferenceMaterials {
  if (!isRecord(value) || !Array.isArray(value.excerpts) || value.excerpts.length > MAX_REFERENCE_EXCERPTS) {
    return false;
  }
  let totalCharacters = 0;
  for (const excerpt of value.excerpts) {
    if (!isSerializedReferenceExcerpt(excerpt)) return false;
    totalCharacters += excerpt.text.length;
    if (totalCharacters > MAX_REFERENCE_CHARACTERS) return false;
  }
  return true;
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

function isSerializedReferenceExcerpt(value: unknown): value is SerializedReferenceExcerpt {
  if (!isRecord(value)) return false;
  return (
    typeof value.sourceId === 'string' &&
    value.sourceId.length > 0 &&
    value.sourceId.length <= 256 &&
    typeof value.sourceTitle === 'string' &&
    value.sourceTitle.length > 0 &&
    value.sourceTitle.length <= 256 &&
    isRevision(value.start) &&
    isRevision(value.end) &&
    value.end >= value.start &&
    typeof value.text === 'string' &&
    value.text.length > 0 &&
    value.text.length <= MAX_REFERENCE_CHARACTERS
  );
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
