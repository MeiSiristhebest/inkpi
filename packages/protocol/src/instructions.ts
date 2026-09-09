/**
 * Process-safe instruction metadata. Instruction content is registered and
 * composed inside the Runtime; provenance travels with the metadata only.
 */
export interface InstructionProvenance {
  source: string;
  skillId?: string;
  skillVersion?: string;
  extensionId?: string;
  extensionVersion?: string;
}

export type InstructionScope = 'system' | 'task' | 'skill' | 'extension';

export interface InstructionDefinition {
  id: string;
  version: string;
  taskKind: string;
  systemInstruction: string;
  provenance?: InstructionProvenance;
}

export interface InstructionEntry {
  id: string;
  scope: InstructionScope;
  content: string;
  priority?: number;
  tags?: string[];
  enabled?: boolean;
  version?: string;
  source?: string;
  provenance?: InstructionProvenance;
}

/** Safe reference used in task results and Runtime status snapshots. */
export interface InstructionReference {
  id: string;
  scope: InstructionScope;
  version?: string;
  source?: string;
  tags?: string[];
  provenance?: InstructionProvenance;
}

export interface InstructionRegisterParams {
  instruction?: InstructionDefinition;
  instructions?: InstructionDefinition[];
}

export type InstructionRegistrationState = 'added' | 'updated' | 'unchanged';

export interface InstructionRegistrationStatus {
  id: string;
  version: string;
  status: InstructionRegistrationState;
  provenance?: InstructionProvenance;
}

export interface InstructionRegisterResult {
  success: true;
  registered: true;
  count: number;
  instructionIds: string[];
  added: string[];
  updated: string[];
  unchanged: string[];
  results: InstructionRegistrationStatus[];
  version: string;
}

export interface InstructionListParams {
  taskKind?: string;
}

export interface InstructionRegistryStatus {
  ready: boolean;
  version: string;
  count: number;
  instructionIds: string[];
  instructions: InstructionReference[];
}
