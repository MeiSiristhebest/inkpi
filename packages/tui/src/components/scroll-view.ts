/**
 * 虚拟化滚动容器组件 (1:1 对标 pi-tui ScrollView)
 */

import { Component, type RenderContext } from '../layout.js';
import { visibleWidth, ANSI } from '../render.js';

export interface ScrollViewOptions {
  content?: string[];
  scrollOffset?: number;
  showScrollbar?: boolean;
}

export class ScrollView extends Component {
  public content: string[] = [];
  public scrollOffset = 0;
  public showScrollbar = true;

  constructor(options: ScrollViewOptions = {}) {
    super();
    if (options.content) this.content = [...options.content];
    if (options.scrollOffset !== undefined) this.scrollOffset = options.scrollOffset;
    if (options.showScrollbar !== undefined) this.showScrollbar = options.showScrollbar;
  }

  public setContent(lines: string[]): void {
    this.content = [...lines];
    this.clampScroll();
  }

  public scrollBy(delta: number, viewHeight?: number): void {
    this.scrollOffset += delta;
    if (viewHeight !== undefined) {
      this.clampScroll(viewHeight);
    } else {
      if (this.scrollOffset < 0) this.scrollOffset = 0;
    }
  }

  public scrollTo(offset: number): void {
    this.scrollOffset = Math.max(0, offset);
  }

  private clampScroll(viewHeight = 10): void {
    const maxOffset = Math.max(0, this.content.length - viewHeight);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }

  public render(context: RenderContext): string[] {
    const { width, height } = context;
    this.clampScroll(height);

    const totalLines = this.content.length;
    const visibleSlice = this.content.slice(this.scrollOffset, this.scrollOffset + height);

    while (visibleSlice.length < height) {
      visibleSlice.push('');
    }

    if (!this.showScrollbar || totalLines <= height) {
      return visibleSlice.map((line) => {
        const w = visibleWidth(line);
        return line + ' '.repeat(Math.max(0, width - w));
      });
    }

    // Render with vertical scrollbar on the rightmost column
    const contentWidth = Math.max(1, width - 1);
    const scrollbarThumbHeight = Math.max(1, Math.floor((height / totalLines) * height));
    const maxScroll = Math.max(1, totalLines - height);
    const thumbTop = Math.floor((this.scrollOffset / maxScroll) * (height - scrollbarThumbHeight));

    return visibleSlice.map((line, idx) => {
      const w = visibleWidth(line);
      const text = line + ' '.repeat(Math.max(0, contentWidth - w));
      const isThumb = idx >= thumbTop && idx < thumbTop + scrollbarThumbHeight;
      const barChar = isThumb ? `${ANSI.FG_CYAN}█${ANSI.RESET}` : `${ANSI.FG_GRAY}│${ANSI.RESET}`;
      return text + barChar;
    });
  }
}
