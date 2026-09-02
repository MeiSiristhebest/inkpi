/**
 * 虚拟化滚动容器组件
 */

import { Component, type RenderContext } from '../../layout.js';
import { visibleWidth, ANSI } from '../../render.js';

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

    // 只读视口计算：scrollOffset 可能因内容缩水 / 视图变高而越界，
    // 本次绘制用局部 clamp 后的 offset，不写回 this.scrollOffset——
    // render 不得静默修改组件状态（旧实现直接在渲染期调用 clampScroll 写回）。
    // 显式状态推进走 scrollBy / scrollTo / setContent（后者内部已 clamp）。
    const totalLines = this.content.length;
    const maxOffset = Math.max(0, totalLines - height);
    const offset = Math.max(0, Math.min(this.scrollOffset, maxOffset));

    const visibleSlice = this.content.slice(offset, offset + height);

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
    const thumbTop = Math.floor((offset / maxScroll) * (height - scrollbarThumbHeight));

    return visibleSlice.map((line, idx) => {
      const w = visibleWidth(line);
      const text = line + ' '.repeat(Math.max(0, contentWidth - w));
      const isThumb = idx >= thumbTop && idx < thumbTop + scrollbarThumbHeight;
      const barChar = isThumb ? `${ANSI.FG_CYAN}█${ANSI.RESET}` : `${ANSI.FG_GRAY}│${ANSI.RESET}`;
      return text + barChar;
    });
  }
}
