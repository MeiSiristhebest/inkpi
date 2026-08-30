export interface EditorSelection {
  from: number;
  to: number;
  head?: number;
  anchor?: number;
}

export interface GhostTextSuggestion {
  id: string;
  pos: number;
  text: string;
  source?: string;
  confidence?: number;
  createdAt: number;
}

export interface GhostTextState {
  active: boolean;
  current?: GhostTextSuggestion | null;
}

export interface TypographyOptions {
  enabled: boolean;
  indentString?: string;
  preventPunctuationAtLineStart?: boolean;
}

export interface ProseStep {
  stepType: string;
  from?: number;
  to?: number;
  slice?: unknown;
  structure?: boolean;
}
