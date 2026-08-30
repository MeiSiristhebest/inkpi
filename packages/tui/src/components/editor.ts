/**
 * 终端文本编辑器 UI 组件 (1:1 对标 pi-tui Editor)
 */

import { Component, type RenderContext } from '../layout.js';
import { visibleWidth, ANSI } from '../render.js';
import type { KeyEvent } from '../keys.js';

export interface EditorOptions {
  text?: string;
  showLineNumbers?: boolean;
  readOnly?: boolean;
}

export class Editor extends Component {
  public lines: string[] = [''];
  public cursorRow = 0;
  public cursorCol = 0;
  public scrollRow = 0;
  public showLineNumbers = true;
  public readOnly = false;

  constructor(options: EditorOptions = {}) {
    super();
    if (options.text) {
      this.lines = options.text.split('\n');
    }
    if (options.showLineNumbers !== undefined) this.showLineNumbers = options.showLineNumbers;
    if (options.readOnly !== undefined) this.readOnly = options.readOnly;
  }

  public getText(): string {
    return this.lines.join('\n');
  }

  public setText(text: string): void {
    this.lines = text.split('\n');
    this.cursorRow = Math.min(this.cursorRow, this.lines.length - 1);
    this.cursorCol = Math.min(this.cursorCol, (this.lines[this.cursorRow] || '').length);
  }

  public handleKey(key: KeyEvent): boolean {
    if (this.readOnly) return false;

    if (key.name === 'up') {
      if (this.cursorRow > 0) {
        this.cursorRow--;
        this.cursorCol = Math.min(this.cursorCol, (this.lines[this.cursorRow] || '').length);
      }
      return true;
    }

    if (key.name === 'down') {
      if (this.cursorRow < this.lines.length - 1) {
        this.cursorRow++;
        this.cursorCol = Math.min(this.cursorCol, (this.lines[this.cursorRow] || '').length);
      }
      return true;
    }

    if (key.name === 'left') {
      if (this.cursorCol > 0) {
        this.cursorCol--;
      } else if (this.cursorRow > 0) {
        this.cursorRow--;
        this.cursorCol = (this.lines[this.cursorRow] || '').length;
      }
      return true;
    }

    if (key.name === 'right') {
      const curLine = this.lines[this.cursorRow] || '';
      if (this.cursorCol < curLine.length) {
        this.cursorCol++;
      } else if (this.cursorRow < this.lines.length - 1) {
        this.cursorRow++;
        this.cursorCol = 0;
      }
      return true;
    }

    if (key.name === 'home') {
      this.cursorCol = 0;
      return true;
    }

    if (key.name === 'end') {
      this.cursorCol = (this.lines[this.cursorRow] || '').length;
      return true;
    }

    if (key.name === 'enter') {
      const curLine = this.lines[this.cursorRow] || '';
      const before = curLine.slice(0, this.cursorCol);
      const after = curLine.slice(this.cursorCol);
      this.lines.splice(this.cursorRow, 1, before, after);
      this.cursorRow++;
      this.cursorCol = 0;
      return true;
    }

    if (key.name === 'backspace') {
      if (this.cursorCol > 0) {
        const curLine = this.lines[this.cursorRow] || '';
        const before = curLine.slice(0, this.cursorCol - 1);
        const after = curLine.slice(this.cursorCol);
        this.lines[this.cursorRow] = before + after;
        this.cursorCol--;
      } else if (this.cursorRow > 0) {
        const prevLine = this.lines[this.cursorRow - 1] || '';
        const curLine = this.lines[this.cursorRow] || '';
        this.cursorCol = prevLine.length;
        this.lines.splice(this.cursorRow - 1, 2, prevLine + curLine);
        this.cursorRow--;
      }
      return true;
    }

    if (key.name === 'delete') {
      const curLine = this.lines[this.cursorRow] || '';
      if (this.cursorCol < curLine.length) {
        const before = curLine.slice(0, this.cursorCol);
        const after = curLine.slice(this.cursorCol + 1);
        this.lines[this.cursorRow] = before + after;
      } else if (this.cursorRow < this.lines.length - 1) {
        const nextLine = this.lines[this.cursorRow + 1] || '';
        this.lines.splice(this.cursorRow, 2, curLine + nextLine);
      }
      return true;
    }

    if (key.name && key.name.length === 1 && !key.ctrl && !key.meta) {
      const curLine = this.lines[this.cursorRow] || '';
      const before = curLine.slice(0, this.cursorCol);
      const after = curLine.slice(this.cursorCol);
      this.lines[this.cursorRow] = before + key.name + after;
      this.cursorCol++;
      return true;
    }

    return false;
  }

  public render(context: RenderContext): string[] {
    const { width, height } = context;

    // Adjust scrollRow to keep cursor visible
    if (this.cursorRow < this.scrollRow) {
      this.scrollRow = this.cursorRow;
    } else if (this.cursorRow >= this.scrollRow + height) {
      this.scrollRow = this.cursorRow - height + 1;
    }

    const rendered: string[] = [];
    const maxLineNumW = String(this.lines.length).length + 2;

    for (let r = 0; r < height; r++) {
      const actualLineIdx = this.scrollRow + r;
      if (actualLineIdx < this.lines.length) {
        const lineContent = this.lines[actualLineIdx] || '';
        let prefix = '';
        let availableWidth = width;

        if (this.showLineNumbers) {
          const numStr = String(actualLineIdx + 1).padStart(maxLineNumW - 1, ' ') + ' ';
          prefix = `${ANSI.FG_GRAY}${numStr}${ANSI.RESET}`;
          availableWidth = Math.max(1, width - maxLineNumW);
        }

        let formattedLine = lineContent;
        if (actualLineIdx === this.cursorRow) {
          // Highlight cursor position
          const before = lineContent.slice(0, this.cursorCol);
          const charUnder = lineContent[this.cursorCol] || ' ';
          const after = lineContent.slice(this.cursorCol + 1);
          formattedLine = `${before}${ANSI.INVERSE}${charUnder}${ANSI.RESET}${after}`;
        }

        const lineW = visibleWidth(lineContent);
        const pad = Math.max(0, availableWidth - lineW);
        rendered.push(prefix + formattedLine + ' '.repeat(pad));
      } else {
        const emptyPrefix = this.showLineNumbers ? `${ANSI.FG_GRAY}${'~'.padStart(maxLineNumW - 1, ' ')} ${ANSI.RESET}` : '';
        const padW = Math.max(0, width - (this.showLineNumbers ? maxLineNumW : 0));
        rendered.push(emptyPrefix + ' '.repeat(padW));
      }
    }

    return rendered;
  }
}
