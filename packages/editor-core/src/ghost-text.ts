import type { GhostTextState, GhostTextSuggestion } from '@inkpi/protocol';
import type { HeadlessEditorState } from './state.js';

export class GhostTextManager {
  private state: GhostTextState = {
    active: false,
    current: null
  };

  private editor: HeadlessEditorState;

  constructor(editor: HeadlessEditorState) {
    this.editor = editor;
  }

  public setGhostText(pos: number, text: string, source = 'ai-stream'): GhostTextSuggestion {
    const suggestion: GhostTextSuggestion = {
      id: `gt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      pos,
      text,
      source,
      createdAt: Date.now()
    };

    this.state = {
      active: true,
      current: suggestion
    };

    return suggestion;
  }

  public suggest(text: string, pos?: number): GhostTextSuggestion {
    const targetPos = pos !== undefined ? pos : this.editor.getText().length;
    return this.setGhostText(targetPos, text);
  }

  public getGhostText(): GhostTextSuggestion | null {
    return this.state.current || null;
  }

  public getCurrentGhostText(): GhostTextSuggestion | null {
    return this.getGhostText();
  }

  public getSuggestion(): string | undefined {
    return this.state.current?.text;
  }

  public hasGhostText(): boolean {
    return this.state.active && Boolean(this.state.current?.text);
  }

  public acceptGhostText(): boolean {
    if (!this.hasGhostText() || !this.state.current) {
      return false;
    }

    const { pos, text } = this.state.current;
    this.editor.insertText(pos, text);
    this.dismissGhostText();
    return true;
  }

  public acceptWord(): boolean {
    if (!this.hasGhostText() || !this.state.current) return false;
    const { pos, text } = this.state.current;
    if (!text) return false;

    const match = text.match(/^([\u4e00-\u9fa5]+|[a-zA-Z0-9_-]+|\s+|[^\s\w\u4e00-\u9fa5]+)/);
    const word = match ? match[0] : text[0];

    this.editor.insertText(pos, word);

    const remaining = text.slice(word.length);
    if (remaining.length > 0) {
      this.state.current = {
        ...this.state.current,
        pos: pos + word.length,
        text: remaining
      };
    } else {
      this.dismissGhostText();
    }
    return true;
  }

  public acceptLine(): boolean {
    if (!this.hasGhostText() || !this.state.current) return false;
    const { pos, text } = this.state.current;
    if (!text) return false;

    const newlineIdx = text.indexOf('\n');
    const line = newlineIdx !== -1 ? text.slice(0, newlineIdx + 1) : text;
    this.editor.insertText(pos, line);

    const remaining = text.slice(line.length);
    if (remaining.length > 0) {
      this.state.current = {
        ...this.state.current,
        pos: pos + line.length,
        text: remaining
      };
    } else {
      this.dismissGhostText();
    }
    return true;
  }

  public accept(): boolean {
    return this.acceptGhostText();
  }

  public dismissGhostText(): void {
    this.state = {
      active: false,
      current: null
    };
  }

  public dismiss(): void {
    this.dismissGhostText();
  }

  public getState(): GhostTextState {
    return { ...this.state };
  }
}
