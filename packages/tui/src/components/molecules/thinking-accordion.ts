/**
 * 思考链原生流式折叠组件 (ThinkingAccordion)
 * 专门处理 DeepSeek-R1 / Claude 3.7 Sonnet / o3-mini 推理思考流
 * 支持实时流式追加、耗时统计、Token 计数与一键折叠/展开呈现
 */

import type { KeyEvent } from '../../keys.js';
import { Component, type RenderContext } from '../../layout.js';
import { ANSI, visibleWidth } from '../../render.js';

export interface ThinkingAccordionOptions {
  thinkingText?: string;
  isCollapsed?: boolean;
  modelName?: string;
  elapsedMs?: number;
}

export class ThinkingAccordion extends Component {
  public thinkingText = '';
  public isCollapsed = true;
  public modelName = 'Reasoning Model';
  public elapsedMs = 0;
  public isStreaming = false;
  private startTime = 0;

  constructor(options: ThinkingAccordionOptions = {}) {
    super();
    if (options.thinkingText) this.thinkingText = options.thinkingText;
    if (options.isCollapsed !== undefined) this.isCollapsed = options.isCollapsed;
    if (options.modelName) this.modelName = options.modelName;
    if (options.elapsedMs) this.elapsedMs = options.elapsedMs;
  }

  public startStreaming(): void {
    this.isStreaming = true;
    this.startTime = Date.now();
    this.isCollapsed = false; // 流式阶段默认展开展示思考过程
  }

  public appendThinking(chunk: string): void {
    this.thinkingText += chunk;
    if (this.startTime > 0) {
      this.elapsedMs = Date.now() - this.startTime;
    }
  }

  public finishStreaming(): void {
    this.isStreaming = false;
    if (this.startTime > 0) {
      this.elapsedMs = Date.now() - this.startTime;
    }
  }

  public toggleCollapse(): void {
    this.isCollapsed = !this.isCollapsed;
  }

  public handleKey(key: KeyEvent): boolean {
    if ((key.ctrl && key.name === 'o') || key.name === 'space' || key.name === 'enter') {
      this.toggleCollapse();
      return true;
    }
    return false;
  }

  public render(context: RenderContext): string[] {
    const { width } = context;
    const lines: string[] = [];

    // Header bar
    const arrow = this.isCollapsed ? '▶' : '▼';
    const statusText = this.isStreaming
      ? ' (Thinking in progress...)'
      : ` (Done in ${(this.elapsedMs / 1000).toFixed(1)}s)`;
    const countText = ` | ~${this.thinkingText.length} chars`;
    const headerTitle = `${arrow} 💡 深度推演思考链 [${this.modelName}]${statusText}${countText} [Ctrl+O 展开/收起]`;
    const fullHeader = ` ${headerTitle}`;
    const headerW = visibleWidth(fullHeader);
    const pad = Math.max(0, width - headerW);
    lines.push(`${ANSI.BG_BLUE}${ANSI.FG_WHITE}${fullHeader}${' '.repeat(pad)}${ANSI.RESET}`);

    // If unfolded, display thinking content
    if (!this.isCollapsed && this.thinkingText) {
      const textLines = this.thinkingText.split('\n');
      for (const rawLine of textLines) {
        const maxContentW = Math.max(10, width - 6);
        const displayLine = visibleWidth(rawLine) > maxContentW ? `${rawLine.slice(0, maxContentW - 3)}...` : rawLine;
        const lineW = visibleWidth(displayLine);
        const linePad = Math.max(0, width - lineW - 4);
        lines.push(`${ANSI.FG_GRAY}  │ ${ANSI.FG_CYAN}${displayLine}${' '.repeat(linePad)}${ANSI.RESET}`);
      }
      lines.push(`${ANSI.FG_GRAY}  └── ${'─'.repeat(Math.max(0, width - 8))}${ANSI.RESET}`);
    }

    return lines;
  }
}
