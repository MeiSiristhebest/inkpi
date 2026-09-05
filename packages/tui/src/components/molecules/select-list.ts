/**
 * 键盘驱动的选择列表组件
 */

import type { KeyEvent } from '../../keys.js';
import { Component, type RenderContext } from '../../layout.js';
import { ANSI, truncateToWidth, visibleWidth } from '../../render.js';

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
    return this.items.filter(
      (item) => item.label.toLowerCase().includes(q) || item.description?.toLowerCase().includes(q)
    );
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

  /**
   * 鼠标事件处理（对齐上游 v0.85.1 Commit 9841914）。
   * 契约：纯鼠标悬停 (hover/move) 绝不改变 selectedIndex，
   * 只有显式 press 或 click 时才更新选中项，防止视口剧烈跳动和误触。
   */
  public handleMouse(
    event: { type: 'move' | 'press' | 'click' | 'wheel'; x: number; y: number; button?: string; wheelDelta?: number },
    viewHeight = 10
  ): boolean {
    if (event.type === 'wheel') {
      const delta = event.wheelDelta ?? 1;
      const filtered = this.getFilteredItems();
      this.selectedIndex = Math.max(0, Math.min(filtered.length - 1, this.selectedIndex + delta));
      return true;
    }

    // 纯悬停不改变 selection
    if (event.type !== 'press' && event.type !== 'click') {
      return false;
    }

    const filtered = this.getFilteredItems();
    const listHeight = Math.max(1, viewHeight - 2);
    const scrollOffset = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(listHeight / 2), Math.max(0, filtered.length - listHeight))
    );

    const clickedIndex = scrollOffset + event.y - 1; // 扣除标题栏 1 行
    if (clickedIndex >= 0 && clickedIndex < filtered.length) {
      const item = filtered[clickedIndex];
      if (item && !item.disabled) {
        this.selectedIndex = clickedIndex;
        if (event.type === 'click' && this.onSelect) {
          this.onSelect(item);
        }
        return true;
      }
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
    const scrollOffset = Math.max(
      0,
      Math.min(this.selectedIndex - Math.floor(listHeight / 2), Math.max(0, filtered.length - listHeight))
    );

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
        const styled = isSelected
          ? `${prefix}${ANSI.BOLD}${ANSI.FG_CYAN}${truncated}${ANSI.RESET}`
          : `${prefix}${truncated}`;
        lines.push(`│${styled}${' '.repeat(pad)}│`);
      } else {
        lines.push(`│${' '.repeat(innerWidth)}│`);
      }
    }

    lines.push(`└${'─'.repeat(innerWidth)}┘`);
    return lines;
  }
}
