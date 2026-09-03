/**
 * InkPi TUI 弹性布局原语
 */

import { ANSI, visibleWidth } from './render.js';

export interface LayoutOptions {
  width?: number;
  height?: number;
  flex?: number;
  padding?: number;
  borderColor?: string;
  title?: string;
}

export interface RenderContext {
  width: number;
  height: number;
}

export abstract class Component {
  public flex = 1;
  /**
   * The fixed height/width this component contributes to its parent stack when
   * no explicit size is provided. Non-spacer components default to `0` (they are
   * flexible); `SpacerComponent` overrides this to expose its spacer size.
   * Layout engines call this instead of `instanceof` discrimination.
   */
  public intrinsicSize(): number {
    return 0;
  }
  public abstract render(context: RenderContext): string[];
}

export class BoxComponent extends Component {
  public title: string;
  public borderColor: string;
  public children: Component[] = [];
  public content: string[] = [];

  constructor(options: { title?: string; borderColor?: string; content?: string[]; flex?: number } = {}) {
    super();
    this.title = options.title || '';
    this.borderColor = options.borderColor || ANSI.FG_CYAN;
    this.content = options.content ? [...options.content] : [];
    if (options.flex !== undefined) this.flex = options.flex;
  }

  public addChild(child: Component): this {
    this.children.push(child);
    return this;
  }

  public render(context: RenderContext): string[] {
    const { width, height } = context;
    const innerWidth = Math.max(2, width - 2);
    const innerHeight = Math.max(1, height - 2);

    let innerLines: string[] = [];
    if (this.children.length > 0) {
      for (const child of this.children) {
        innerLines.push(...child.render({ width: innerWidth, height: innerHeight }));
      }
    } else {
      innerLines = [...this.content];
    }

    const lines: string[] = [];
    const titleDisplay = this.title ? ` ${this.title} ` : '';
    const titleWidth = visibleWidth(titleDisplay);
    const topBarLength = Math.max(0, innerWidth - titleWidth);
    lines.push(`${this.borderColor}┌${titleDisplay}${'─'.repeat(topBarLength)}┐${ANSI.RESET}`);

    for (let i = 0; i < innerHeight; i++) {
      const text = innerLines[i] || '';
      const cleanW = visibleWidth(text);
      const pad = Math.max(0, innerWidth - cleanW);
      lines.push(`${this.borderColor}│${ANSI.RESET}${text}${' '.repeat(pad)}${this.borderColor}│${ANSI.RESET}`);
    }

    lines.push(`${this.borderColor}└${'─'.repeat(innerWidth)}┘${ANSI.RESET}`);
    return lines;
  }
}

export class HStackComponent extends Component {
  public children: Array<{ component: Component; width?: number; flex?: number }> = [];

  constructor(children: Array<{ component: Component; width?: number; flex?: number }> = []) {
    super();
    this.children = children;
  }

  public add(component: Component, width?: number, flex = 1): this {
    this.children.push({ component, width, flex });
    return this;
  }

  public render(context: RenderContext): string[] {
    const { width, height } = context;
    const totalExplicitWidth = this.children.reduce((acc, c) => acc + (c.width || 0), 0);
    const flexibleChildren = this.children.filter((c) => !c.width);
    const totalFlex = flexibleChildren.reduce((acc, c) => acc + (c.flex || 1), 0);
    const remainingWidth = Math.max(0, width - totalExplicitWidth - (this.children.length - 1));

    const renderedCols: Array<{ lines: string[]; width: number }> = [];

    for (const child of this.children) {
      let colWidth: number;
      if (child.width) {
        colWidth = child.width;
      } else {
        const share = (child.flex || 1) / (totalFlex || 1);
        colWidth = Math.max(1, Math.floor(remainingWidth * share));
      }

      const colLines = child.component.render({ width: colWidth, height });
      renderedCols.push({ lines: colLines, width: colWidth });
    }

    const rows: string[] = [];
    for (let r = 0; r < height; r++) {
      const rowParts: string[] = [];
      for (const col of renderedCols) {
        const line = col.lines[r] || ' '.repeat(col.width);
        const cleanW = visibleWidth(line);
        const pad = Math.max(0, col.width - cleanW);
        rowParts.push(line + ' '.repeat(pad));
      }
      rows.push(rowParts.join('│'));
    }

    return rows;
  }
}

export class VStackComponent extends Component {
  public children: Array<{ component: Component; height?: number; flex?: number }> = [];

  constructor(children: Array<{ component: Component; height?: number; flex?: number }> = []) {
    super();
    this.children = children;
  }

  public add(component: Component, height?: number, flex = 1): this {
    this.children.push({ component, height, flex });
    return this;
  }

  public render(context: RenderContext): string[] {
    const { width, height } = context;
    const totalExplicitHeight = this.children.reduce((acc, c) => {
      const h = c.height !== undefined ? c.height : c.component.intrinsicSize();
      return acc + h;
    }, 0);
    const flexibleChildren = this.children.filter((c) => c.height === undefined && c.component.intrinsicSize() === 0);
    const totalFlex = flexibleChildren.reduce((acc, c) => acc + (c.flex || 1), 0);
    const remainingHeight = Math.max(0, height - totalExplicitHeight);

    const result: string[] = [];

    for (const child of this.children) {
      let childHeight: number;
      if (child.height !== undefined) {
        childHeight = child.height;
      } else if (child.component.intrinsicSize() > 0) {
        childHeight = child.component.intrinsicSize();
      } else {
        const share = (child.flex || 1) / (totalFlex || 1);
        childHeight = Math.max(1, Math.floor(remainingHeight * share));
      }

      const lines = child.component.render({ width, height: childHeight });
      result.push(...lines);
    }

    while (result.length < height) {
      result.push(' '.repeat(width));
    }

    return result.slice(0, height);
  }
}

export class SpacerComponent extends Component {
  public size: number;
  constructor(size = 1) {
    super();
    this.size = size;
  }
  public intrinsicSize(): number {
    return this.size;
  }
  public render(context: RenderContext): string[] {
    return Array(this.size).fill(' '.repeat(context.width));
  }
}
