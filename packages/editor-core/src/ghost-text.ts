import type { GhostTextSuggestion, GhostTextState } from '@inkpi/protocol';
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
    return this.state.active && Boolean(this.state.current && this.state.current.text);
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
