export interface DocumentNode {
  type: 'doc' | 'paragraph' | 'heading' | 'text' | 'blockquote';
  text?: string;
  attrs?: Record<string, unknown>;
  content?: DocumentNode[];
}

export interface SelectionRange {
  from: number;
  to: number;
}

export interface EditorStep {
  type: 'replace' | 'insert' | 'delete';
  from: number;
  to: number;
  text?: string;
}

export interface EditorTransaction {
  steps: EditorStep[];
  docBefore: DocumentNode;
  docAfter: DocumentNode;
  time: number;
}
