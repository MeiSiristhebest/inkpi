import type { DocumentNode, EditorStep, EditorTransaction, SelectionRange } from './types.js';

export class HeadlessEditorState {
  private doc: DocumentNode;
  private selection: SelectionRange = { from: 0, to: 0 };
  private version = 1;
  private undoStack: EditorTransaction[] = [];
  private redoStack: EditorTransaction[] = [];

  constructor(initialText = '') {
    this.doc = {
      type: 'doc',
      content: initialText
        ? initialText.split('\n').map((line) => ({
            type: 'paragraph',
            content: line ? [{ type: 'text', text: line }] : []
          }))
        : [{ type: 'paragraph', content: [] }]
    };
  }

  public getDoc(): DocumentNode {
    return JSON.parse(JSON.stringify(this.doc));
  }

  public getVersion(): number {
    return this.version;
  }

  public getSelection(): SelectionRange {
    return { ...this.selection };
  }

  public setSelection(from: number, to: number): void {
    this.selection = { from, to };
  }

  public getText(): string {
    const lines: string[] = [];
    if (this.doc.content) {
      for (const p of this.doc.content) {
        if (p.content) {
          const line = p.content.map((t) => t.text || '').join('');
          lines.push(line);
        } else {
          lines.push('');
        }
      }
    }
    return lines.join('\n');
  }

  public getWordCount(): number {
    const text = this.getText();
    if (!text.trim()) return 0;
    // Chinese characters + English words
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (text.replace(/[\u4e00-\u9fa5]/g, ' ').match(/[a-zA-Z0-9_-]+/g) || []).length;
    return chineseChars + englishWords;
  }

  public insert(text: string): EditorTransaction {
    return this.insertText(this.selection.to, text);
  }

  public insertText(pos: number, text: string): EditorTransaction {
    const docBefore = this.getDoc();
    const currentText = this.getText();
    const newText = currentText.slice(0, pos) + text + currentText.slice(pos);

    this.doc = {
      type: 'doc',
      content: newText.split('\n').map((line) => ({
        type: 'paragraph',
        content: line ? [{ type: 'text', text: line }] : []
      }))
    };

    this.version += 1;
    this.selection = { from: pos + text.length, to: pos + text.length };

    const tr: EditorTransaction = {
      steps: [{ type: 'insert', from: pos, to: pos, text }],
      docBefore,
      docAfter: this.getDoc(),
      time: Date.now()
    };

    this.undoStack.push(tr);
    this.redoStack = [];
    return tr;
  }

  public replaceRange(start: number, end: number, text: string): EditorTransaction {
    this.deleteRange(start, end);
    return this.insertText(start, text);
  }

  public deleteRange(from: number, to: number): EditorTransaction {
    const docBefore = this.getDoc();
    const currentText = this.getText();
    const deletedText = currentText.slice(from, to);
    const newText = currentText.slice(0, from) + currentText.slice(to);

    this.doc = {
      type: 'doc',
      content: newText.split('\n').map((line) => ({
        type: 'paragraph',
        content: line ? [{ type: 'text', text: line }] : []
      }))
    };

    this.version += 1;
    this.selection = { from, to: from };

    const tr: EditorTransaction = {
      steps: [{ type: 'delete', from, to, text: deletedText }],
      docBefore,
      docAfter: this.getDoc(),
      time: Date.now()
    };

    this.undoStack.push(tr);
    this.redoStack = [];
    return tr;
  }

  public undo(): boolean {
    if (this.undoStack.length === 0) return false;
    const tr = this.undoStack.pop()!;
    this.redoStack.push(tr);

    this.doc = JSON.parse(JSON.stringify(tr.docBefore));
    this.version += 1;
    return true;
  }

  public redo(): boolean {
    if (this.redoStack.length === 0) return false;
    const tr = this.redoStack.pop()!;
    this.undoStack.push(tr);

    this.doc = JSON.parse(JSON.stringify(tr.docAfter));
    this.version += 1;
    return true;
  }

  public getUndoStackDepth(): number {
    return this.undoStack.length;
  }

  public getRedoStackDepth(): number {
    return this.redoStack.length;
  }

  public clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  public setContent(text: string): void {
    this.doc = {
      type: 'doc',
      content: text.split('\n').map((line) => ({
        type: 'paragraph',
        content: line ? [{ type: 'text', text: line }] : []
      }))
    };
    this.version += 1;
    this.clearHistory();
  }
}
