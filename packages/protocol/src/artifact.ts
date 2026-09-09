/** Runtime semantic output. JSON/Markdown are export formats, not storage types. */
export interface ArtifactProvenance {
  taskId?: string;
  executionRunId?: string;
  sessionId?: string;
  parentArtifactId?: string;
  [key: string]: unknown;
}

export interface Artifact {
  id: string;
  type: string;
  version: number;
  content: unknown;
  provenance: ArtifactProvenance;
  createdAt: number;
  updatedAt: number;
}

/** Storage port shared by Runtime and storage adapters. */
export interface ArtifactStore {
  save(artifact: Artifact): Promise<void> | void;
  get(id: string): Promise<Artifact | undefined> | Artifact | undefined;
  list(taskId?: string): Promise<Artifact[]> | Artifact[];
  listByType?(type: string): Promise<Artifact[]> | Artifact[];
}

export const RUNTIME_ARTIFACT_TYPES = {
  storyPlan: 'creative.story-plan',
  characterState: 'creative.character-state',
  openThreads: 'creative.open-threads',
  chapterSummary: 'creative.chapter-summary',
  auditReport: 'creative.audit-report',
  distillationCheckpoint: 'creative.distillation-checkpoint'
} as const;
