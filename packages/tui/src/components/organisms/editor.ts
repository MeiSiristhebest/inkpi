/**
 * 终端高阶文本编辑器 UI 组件
 * 具备 Kill-Ring（剪切环栈）、Undo/Redo 多级撤销、硬件光标定位与 @/#/ 智能触发补全
 */

import { Component, type RenderContext } from '../../layout.js';
import { visibleWidth, ANSI } from '../../render.js';
import type { KeyEvent } from '../../keys.js';

export interface AutocompleteItem {
  label: string;
  detail?: string;
  insertText?: string;
}

export type AutocompleteProvider = (trigger: '@' | '#' | '/', query: string) => AutocompleteItem[];

export interface EditorOptions {
  text?: string;
  showLineNumbers?: boolean;
  readOnly?: boolean;
  completionProvider?: AutocompleteProvider;
}

/**
 * 纯函数：计算把光标保持在可视区内所需的滚动行号。
 * 不改任何状态；调用方（ensureCursorVisible / render）自行决定如何使用结果。
 */
function cursorFollowScrollRow(cursorRow: number, scrollRow: number, lineCount: number, viewHeight: number): number {
  if (viewHeight <= 0) return scrollRow;
  let row = scrollRow;
  if (cursorRow < row) {
    row = cursorRow;
  } else if (cursorRow >= row + viewHeight) {
    row = cursorRow - viewHeight + 1;
  }
  // 与旧渲染副作用保持同一公式：光标正常情况下恒在 [0, lineCount) 内，
  // 因此无需额外 clamp（退化输入由调用方负责约束）。
  return row;
}

export class Editor extends Component {
  public lines: string[] = [''];
  public cursorRow = 0;
  public cursorCol = 0;
  public scrollRow = 0;
  public showLineNumbers = true;
  public readOnly = false;

  // Undo / Redo Multi-Level History Stack
  private undoStack: Array<{ lines: string[]; cursorRow: number; cursorCol: number }> = [];
  private redoStack: Array<{ lines: string[]; cursorRow: number; cursorCol: number }> = [];
  private maxHistory = 100;

  // Kill-Ring Stack
  private killRing: string[] = [];

  // Autocomplete State
  public completionProvider?: AutocompleteProvider;
  public isCompleting = false;
  public completeTrigger: '@' | '#' | '/' | null = null;
  public completeQuery = '';
  public completeIndex = 0;
  public completionItems: AutocompleteItem[] = [];

  constructor(options: EditorOptions = {}) {
    super();
    if (options.text) {
      this.lines = options.text.split('\n');
    }
    if (options.showLineNumbers !== undefined) this.showLineNumbers = options.showLineNumbers;
    if (options.readOnly !== undefined) this.readOnly = options.readOnly;
    if (options.completionProvider) this.completionProvider = options.completionProvider;
  }

  public getText(): string {
    return this.lines.join('\n');
  }

  public setText(text: string): void {
    this.saveHistory();
    this.lines = text.split('\n');
    this.cursorRow = Math.min(this.cursorRow, this.lines.length - 1);
    this.cursorCol = Math.min(this.cursorCol, (this.lines[this.cursorRow] || '').length);
  }

  private saveHistory(): void {
    this.undoStack.push({
      lines: [...this.lines],
      cursorRow: this.cursorRow,
      cursorCol: this.cursorCol
    });
    if (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
    this.redoStack = []; // 清空重做栈
  }

  public undo(): boolean {
    if (this.undoStack.length === 0) return false;
    const current = {
      lines: [...this.lines],
      cursorRow: this.cursorRow,
      cursorCol: this.cursorCol
    };
    this.redoStack.push(current);

    const prev = this.undoStack.pop()!;
    this.lines = prev.lines;
    this.cursorRow = prev.cursorRow;
    this.cursorCol = prev.cursorCol;
    this.dismissAutocomplete();
    return true;
  }

  public redo(): boolean {
    if (this.redoStack.length === 0) return false;
    const current = {
      lines: [...this.lines],
      cursorRow: this.cursorRow,
      cursorCol: this.cursorCol
    };
    this.undoStack.push(current);

    const next = this.redoStack.pop()!;
    this.lines = next.lines;
    this.cursorRow = next.cursorRow;
    this.cursorCol = next.cursorCol;
    this.dismissAutocomplete();
    return true;
  }

  public killLine(): void {
    this.saveHistory();
    const curLine = this.lines[this.cursorRow] || '';
    if (this.cursorCol < curLine.length) {
      const killed = curLine.slice(this.cursorCol);
      this.lines[this.cursorRow] = curLine.slice(0, this.cursorCol);
      this.killRing.push(killed);
    } else if (this.cursorRow < this.lines.length - 1) {
      const nextLine = this.lines[this.cursorRow + 1] || '';
      this.lines.splice(this.cursorRow, 2, curLine + nextLine);
      this.killRing.push('\n');
    }
  }

  public yank(): void {
    if (this.killRing.length === 0) return;
    this.saveHistory();
    const text = this.killRing[this.killRing.length - 1];
    const curLine = this.lines[this.cursorRow] || '';
    const before = curLine.slice(0, this.cursorCol);
    const after = curLine.slice(this.cursorCol);

    if (text.includes('\n')) {
      const parts = text.split('\n');
      const firstLine = before + parts[0];
      const middleLines = parts.slice(1, -1);
      const lastLine = (parts[parts.length - 1] || '') + after;
      this.lines.splice(this.cursorRow, 1, firstLine, ...middleLines, lastLine);
      this.cursorRow += parts.length - 1;
      this.cursorCol = (parts[parts.length - 1] || '').length;
    } else {
      this.lines[this.cursorRow] = before + text + after;
      this.cursorCol += text.length;
    }
  }

  private dismissAutocomplete(): void {
    this.isCompleting = false;
    this.completeTrigger = null;
    this.completeQuery = '';
    this.completeIndex = 0;
    this.completionItems = [];
  }

  private updateAutocomplete(): void {
    if (!this.completionProvider) {
      this.dismissAutocomplete();
      return;
    }

    const curLine = this.lines[this.cursorRow] || '';
    const textBeforeCursor = curLine.slice(0, this.cursorCol);

    // 探测最近的 @ / # / /
    const match = textBeforeCursor.match(/([@#/])([a-zA-Z0-9_\u4e00-\u9fa5]*)$/);
    if (match) {
      const trigger = match[1] as '@' | '#' | '/';
      const query = match[2];
      const items = this.completionProvider(trigger, query);
      if (items.length > 0) {
        this.isCompleting = true;
        this.completeTrigger = trigger;
        this.completeQuery = query;
        this.completionItems = items;
        this.completeIndex = Math.min(this.completeIndex, items.length - 1);
        return;
      }
    }

    this.dismissAutocomplete();
  }

  public applyCompletion(): boolean {
    if (!this.isCompleting || this.completionItems.length === 0) return false;
    const selected = this.completionItems[this.completeIndex];
    if (!selected) return false;

    this.saveHistory();
    const curLine = this.lines[this.cursorRow] || '';
    const textBeforeCursor = curLine.slice(0, this.cursorCol);
    const textAfterCursor = curLine.slice(this.cursorCol);

    const triggerIdx = textBeforeCursor.lastIndexOf(this.completeTrigger!);
    if (triggerIdx !== -1) {
      const beforeTrigger = textBeforeCursor.slice(0, triggerIdx);
      const insert = selected.insertText || selected.label;
      this.lines[this.cursorRow] = beforeTrigger + insert + textAfterCursor;
      this.cursorCol = beforeTrigger.length + insert.length;
    }

    this.dismissAutocomplete();
    return true;
  }

  public handleKey(key: KeyEvent): boolean {
    if (this.readOnly) return false;

    // 1. 补全浮层导航与响应
    if (this.isCompleting) {
      if (key.name === 'up') {
        if (this.completeIndex > 0) {
          this.completeIndex--;
        } else {
          this.completeIndex = this.completionItems.length - 1;
        }
        return true;
      }
      if (key.name === 'down') {
        if (this.completeIndex < this.completionItems.length - 1) {
          this.completeIndex++;
        } else {
          this.completeIndex = 0;
        }
        return true;
      }
      if (key.name === 'tab' || key.name === 'enter') {
        return this.applyCompletion();
      }
      if (key.name === 'escape') {
        this.dismissAutocomplete();
        return true;
      }
    }

    // 2. 快捷键：Undo (Ctrl+Z), Redo (Ctrl+Y), Kill-line (Ctrl+K)
    if (key.ctrl && key.name === 'z') {
      return this.undo();
    }
    if (key.ctrl && key.name === 'y') {
      return this.redo();
    }
    if (key.ctrl && key.name === 'k') {
      this.killLine();
      return true;
    }

    // 3. 基本导航键
    if (key.name === 'up') {
      if (this.cursorRow > 0) {
        this.cursorRow--;
        this.cursorCol = Math.min(this.cursorCol, (this.lines[this.cursorRow] || '').length);
        this.updateAutocomplete();
      }
      return true;
    }

    if (key.name === 'down') {
      if (this.cursorRow < this.lines.length - 1) {
        this.cursorRow++;
        this.cursorCol = Math.min(this.cursorCol, (this.lines[this.cursorRow] || '').length);
        this.updateAutocomplete();
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
      this.updateAutocomplete();
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
      this.updateAutocomplete();
      return true;
    }

    if (key.name === 'home') {
      this.cursorCol = 0;
      this.updateAutocomplete();
      return true;
    }

    if (key.name === 'end') {
      this.cursorCol = (this.lines[this.cursorRow] || '').length;
      this.updateAutocomplete();
      return true;
    }

    if (key.name === 'enter') {
      this.saveHistory();
      const curLine = this.lines[this.cursorRow] || '';
      const before = curLine.slice(0, this.cursorCol);
      const after = curLine.slice(this.cursorCol);
      this.lines.splice(this.cursorRow, 1, before, after);
      this.cursorRow++;
      this.cursorCol = 0;
      this.dismissAutocomplete();
      return true;
    }

    if (key.name === 'backspace') {
      this.saveHistory();
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
      this.updateAutocomplete();
      return true;
    }

    if (key.name === 'delete') {
      this.saveHistory();
      const curLine = this.lines[this.cursorRow] || '';
      if (this.cursorCol < curLine.length) {
        const before = curLine.slice(0, this.cursorCol);
        const after = curLine.slice(this.cursorCol + 1);
        this.lines[this.cursorRow] = before + after;
      } else if (this.cursorRow < this.lines.length - 1) {
        const nextLine = this.lines[this.cursorRow + 1] || '';
        this.lines.splice(this.cursorRow, 2, curLine + nextLine);
      }
      this.updateAutocomplete();
      return true;
    }

    // 普通字符输入
    if (key.name && key.name.length === 1 && !key.ctrl && !key.meta) {
      this.saveHistory();
      const curLine = this.lines[this.cursorRow] || '';
      const before = curLine.slice(0, this.cursorCol);
      const after = curLine.slice(this.cursorCol);
      this.lines[this.cursorRow] = before + key.name + after;
      this.cursorCol++;
      this.updateAutocomplete();
      return true;
    }

    return false;
  }

  /**
   * 显式光标跟随：推进模型滚动状态，使光标落入可视区。
   *
   * 这是唯一允许修改 scrollRow 的入口。旧实现把这段逻辑藏在 render() 里
   * （渲染期间静默改写组件状态，属副作用坏味道——渲染函数应可重复调用且不改变模型）。
   * 调用方在每次绘制前按需调用一次即可；render() 本身只做只读视口计算。
   */
  public ensureCursorVisible(viewHeight: number): void {
    this.scrollRow = cursorFollowScrollRow(this.cursorRow, this.scrollRow, this.lines.length, viewHeight);
  }

  public render(context: RenderContext): string[] {
    const { width, height } = context;

    // 只读视口计算：此处用局部 scrollRow 决定本次绘制的窗口，绝不写 this.scrollRow。
    // 若调用方希望模型滚动状态同步推进，应先调用 ensureCursorVisible(height)。
    const scrollRow = cursorFollowScrollRow(this.cursorRow, this.scrollRow, this.lines.length, height);

    const rendered: string[] = [];
    const maxLineNumW = String(this.lines.length).length + 2;

    for (let r = 0; r < height; r++) {
      const actualLineIdx = scrollRow + r;
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
          // Highlight cursor position with CURSOR_MARKER for hardware cursor & IME positioning
          const before = lineContent.slice(0, this.cursorCol);
          const charUnder = lineContent[this.cursorCol] || ' ';
          const after = lineContent.slice(this.cursorCol + 1);
          formattedLine = `${before}\x1b_pi:c\x07${ANSI.INVERSE}${charUnder}${ANSI.RESET}${after}`;
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

    // 若当前正在补全，在下一行或指定位置合成补全建议下拉面板
    if (this.isCompleting && this.completionItems.length > 0) {
      const popupY = Math.min(height - 1, this.cursorRow - scrollRow + 1);
      if (popupY >= 0 && popupY < rendered.length) {
        const itemsPreview = this.completionItems
          .slice(0, 4)
          .map((item, idx) => {
            const isSelected = idx === this.completeIndex;
            const prefix = isSelected ? `${ANSI.BG_BLUE}${ANSI.FG_WHITE} ▶ ` : '   ';
            const detailStr = item.detail ? ` (${item.detail})` : '';
            const text = `${prefix}${item.label}${detailStr}${ANSI.RESET}`;
            return text;
          })
          .join(' | ');

        rendered[popupY] = `  ${ANSI.FG_CYAN}💡 补全建议 [Tab/Enter]: ${ANSI.RESET}${itemsPreview}`.padEnd(width, ' ');
      }
    }

    return rendered;
  }
}
