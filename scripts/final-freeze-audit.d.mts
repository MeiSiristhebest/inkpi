export interface FreezeEvidenceGroup {
  id: string;
  label: string;
  status: 'passed' | 'failed' | 'missing';
  hasSource: boolean;
  recordedAt?: string;
  localStatus: 'passed' | 'partial' | 'failed' | 'missing';
  localHasSource: boolean;
  localRecordedAt?: string;
}

export interface FreezeEvidenceReport {
  schemaVersion: 1;
  status: 'passed' | 'pending';
  eligible: boolean;
  requiredGroupCount: number;
  passedGroupCount: number;
  localEvidenceGroupCount: number;
  localPartialGroupCount: number;
  localFailed: string[];
  localMissing: string[];
  missing: string[];
  failed: string[];
  groups: FreezeEvidenceGroup[];
}

export const FINAL_FREEZE_GROUPS: readonly { id: string; label: string }[];
export function evaluateFreezeEvidence(input: unknown): FreezeEvidenceReport;
export function readFreezeEvidence(filePath: string | undefined): Record<string, unknown>;
