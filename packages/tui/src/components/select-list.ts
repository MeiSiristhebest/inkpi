/**
 * 键盘驱动的选择列表组件 (1:1 对标 pi-tui SelectList)
 */

import { Component, type RenderContext } from '../layout.js';
import { visibleWidth, truncateToWidth, ANSI } from '../render.js';
import type { KeyEvent } from '../keys.js';

export interface SelectListItem<T = any> {
  id: string;
  label: string;
  description?: string;
  value?: T;
  disabled?: boolean;
}

export interface SelectListOptions<T = any> {
  title?: string;
  items?: SelectListItem<T>[];
  selectedIndex?: number;
  onSelect?: (item: SelectListItem<T>) => void;
  onCancel?: () => void;
}

export class SelectList<T = any> extends Component {
  public title: string;
  public items: SelectListItem<T>[] = [];
  public selectedIndex = 0;
  public filterQuery = '';
  public onSelect?: (item: SelectListItem<T>) => void;
  public onCancel?: () => void;

  constructor(options: SelectListOptions<T> = {}) {
    super();
    this.title = options.title || '请选择';
    if (options.items) this.items = [...options.items];
    if (options.selectedIndex !== undefined) this.selectedIndex = options.selectedIndex;
    this.onSelect = options.onSelect;
    this.onCancel = options.onCancel;
  }

  public getFilteredItems(): SelectListItem<T>[] {
    if (!this.filterQuery.trim()) return this.items;
    const q = this.filterQuery.toLowerCase();
    return this.items.filter((item) => item.label.toLowerCase().includes(q) || (item.description && item.description.toLowerCase().includes(q)));
  }

  public handleKey(key: KeyEvent): boolean {
    const filtered = this.getFilteredItems();

    if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
      if (this.selectedIndex > 0) {
        this.selectedIndex--;
      } else {
        this.selectedIndex = Math.max(0, filtered.length - 1);
      }
      return true;
    }

    if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
      if (this.selectedIndex < filtered.length - 1) {
        this.selectedIndex++;
      } else {
        this.selectedIndex = 0;
      }
      return true;
    }

    if (key.name === 'enter') {
      const selected = filtered[this.selectedIndex];
      if (selected && !selected.disabled && this.onSelect) {
        this.onSelect(selected);
      }
      return true;
    }

    if (key.name === 'escape') {
      if (this.onCancel) this.onCancel();
      return true;
    }

    if (key.name === 'backspace') {
      if (this.filterQuery.length > 0) {
        this.filterQuery = this.filterQuery.slice(0, -1);
        this.selectedIndex = 0;
      }
      return true;
    }

    if (key.name && key.name.length === 1 && !key.ctrl && !key.meta) {
      this.filterQuery += key.name;
      this.selectedIndex = 0;
      return true;
    }

    return false;
  }

  public render(context: RenderContext): string[] {
    const { width, height } = context;
    const lines: string[] = [];
    const innerWidth = Math.max(10, width - 2);

    // Title / Search bar
    const searchDisplay = `🔍 ${this.title}: ${this.filterQuery}${ANSI.INVERSE} ${ANSI.RESET}`;
    const headerInner = `─ ${searchDisplay} `;
    const headerInnerW = visibleWidth(headerInner);
    const searchPad = Math.max(0, innerWidth - headerInnerW);
    lines.push(`┌${headerInner}${'─'.repeat(searchPad)}┐`);

    const filtered = this.getFilteredItems();
    const listHeight = Math.max(1, height - 2);
    const scrollOffset = Math.max(0, Math.min(this.selectedIndex - Math.floor(listHeight / 2), Math.max(0, filtered.length - listHeight)));

    for (let i = 0; i < listHeight; i++) {
      const itemIndex = scrollOffset + i;
      const item = filtered[itemIndex];
      if (item) {
        const isSelected = itemIndex === this.selectedIndex;
        const prefix = isSelected ? `${ANSI.FG_CYAN}👉 ` : '   ';
        const label = item.label + (item.description ? ` (${item.description})` : '');
        const maxTextW = innerWidth - 4;
        const truncated = truncateToWidth(label, maxTextW);
        const itemW = visibleWidth(prefix + truncated);
        const pad = Math.max(0, innerWidth - itemW);
        const styled = isSelected ? `${prefix}${ANSI.BOLD}${ANSI.FG_CYAN}${truncated}${ANSI.RESET}` : `${prefix}${truncated}`;
        lines.push(`│${styled}${' '.repeat(pad)}│`);
      } else {
        lines.push(`│${' '.repeat(innerWidth)}│`);
      }
    }


    lines.push(`└${'─'.repeat(innerWidth)}┘`);
    return lines;
  }
}
