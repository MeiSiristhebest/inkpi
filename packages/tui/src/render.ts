/**
 * InkPi TUI 差量渲染与 ANSI 样式生成器
 */

export interface ScreenDimensions {
  cols: number;
  rows: number;
}

export const ANSI = {
  RESET: '\x1b[0m',
  BOLD: '\x1b[1m',
  DIM: '\x1b[2m',
  ITALIC: '\x1b[3m',
  UNDERLINE: '\x1b[4m',
  INVERSE: '\x1b[7m',
  HIDDEN: '\x1b[8m',
  STRIKETHROUGH: '\x1b[9m',

  // Foreground
  FG_BLACK: '\x1b[30m',
  FG_RED: '\x1b[31m',
  FG_GREEN: '\x1b[32m',
  FG_YELLOW: '\x1b[33m',
  FG_BLUE: '\x1b[34m',
  FG_MAGENTA: '\x1b[35m',
  FG_CYAN: '\x1b[36m',
  FG_WHITE: '\x1b[37m',
  FG_GRAY: '\x1b[90m',
  FG_BRIGHT_RED: '\x1b[91m',
  FG_BRIGHT_GREEN: '\x1b[92m',
  FG_BRIGHT_YELLOW: '\x1b[93m',
  FG_BRIGHT_BLUE: '\x1b[94m',
  FG_BRIGHT_MAGENTA: '\x1b[95m',
  FG_BRIGHT_CYAN: '\x1b[96m',
  FG_BRIGHT_WHITE: '\x1b[97m',

  // Background
  BG_BLACK: '\x1b[40m',
  BG_RED: '\x1b[41m',
  BG_GREEN: '\x1b[42m',
  BG_YELLOW: '\x1b[43m',
  BG_BLUE: '\x1b[44m',
  BG_MAGENTA: '\x1b[45m',
  BG_CYAN: '\x1b[46m',
  BG_WHITE: '\x1b[47m',
  BG_DARK_GRAY: '\x1b[100m',

  // Cursor controls
  CURSOR_HIDE: '\x1b[?25l',
  CURSOR_SHOW: '\x1b[?25h',
  CLEAR_SCREEN: '\x1b[2J',
  CURSOR_HOME: '\x1b[H',
  ALT_SCREEN_ENTER: '\x1b[?1049h',
  ALT_SCREEN_LEAVE: '\x1b[?1049l'
};

import { stripAnsi, visibleWidth } from './width.js';
export { stripAnsi, visibleWidth };

/**
 * 按终端可视列宽截断字符串
 */
export function truncateToWidth(str: string, maxWidth: number, ellipsis = '...'): string {
  if (maxWidth <= 0) return '';
  const currentWidth = visibleWidth(str);
  if (currentWidth <= maxWidth) return str;

  const ellipsisW = visibleWidth(ellipsis);
  const targetW = Math.max(1, maxWidth - ellipsisW);

  let accumulated = '';
  let curW = 0;

  for (let i = 0; i < str.length; i++) {
    const char = str[i];
    const charW = visibleWidth(char);
    if (curW + charW > targetW) break;
    accumulated += char;
    curW += charW;
  }

  return accumulated + ellipsis;
}

/**
 * 带有全角中文字符宽度补偿的高保真绘制边框函数
 */
export function drawBox(
  title: string,
  contentLines: string[],
  width: number,
  height: number,
  borderColor = ANSI.FG_CYAN
): string[] {
  const lines: string[] = [];
  const innerWidth = Math.max(10, width - 2);

  // Top border
  const titleDisplay = title ? ` ${title} ` : '';
  const titleWidth = visibleWidth(titleDisplay);
  const topBarLength = Math.max(0, innerWidth - titleWidth);
  lines.push(`${borderColor}┌${titleDisplay}${'─'.repeat(topBarLength)}┐${ANSI.RESET}`);

  // Content
  for (let i = 0; i < height - 2; i++) {
    const text = contentLines[i] || '';
    const cleanWidth = visibleWidth(text);
    const padding = Math.max(0, innerWidth - cleanWidth);
    lines.push(`${borderColor}│${ANSI.RESET}${text}${' '.repeat(padding)}${borderColor}│${ANSI.RESET}`);
  }

  // Bottom border
  lines.push(`${borderColor}└${'─'.repeat(innerWidth)}┘${ANSI.RESET}`);

  return lines;
}

/**
 * 差量渲染缓冲计算器
 */
export class DifferentialRenderer {
  private lastBuffer: string[] = [];

  public render(newScreenText: string): {
    changedLines: number;
    output: string;
    diffAnsi: string;
    isDiff: boolean;
  } {
    const currentLines = newScreenText.split('\n');
    let changed = 0;
    const diffSegments: string[] = [];
    const maxLines = Math.max(this.lastBuffer.length, currentLines.length);

    for (let i = 0; i < maxLines; i++) {
      const oldLine = i < this.lastBuffer.length ? this.lastBuffer[i] : undefined;
      const newLine = i < currentLines.length ? currentLines[i] : undefined;

      if (oldLine !== newLine) {
        changed++;
        const row = i + 1;
        if (newLine !== undefined) {
          diffSegments.push(`\x1b[${row};1H\x1b[2K${newLine}`);
        } else {
          diffSegments.push(`\x1b[${row};1H\x1b[2K`);
        }
      }
    }

    this.lastBuffer = [...currentLines];
    return {
      changedLines: changed,
      output: newScreenText,
      diffAnsi: diffSegments.join(''),
      isDiff: changed > 0
    };
  }

  public clear(): void {
    this.lastBuffer = [];
  }
}

/**
 * 纵向堆叠布局容器 (VStack 辅助函数)
 */
export function layoutVStack(items: string[][]): string[] {
  const result: string[] = [];
  for (const block of items) {
    result.push(...block);
  }
  return result;
}

/**
 * 横向并排布局容器 (HStack 辅助函数)
 */
export function layoutHStack(columns: Array<{ lines: string[]; width: number }>, height: number): string[] {
  const rows: string[] = [];
  for (let r = 0; r < height; r++) {
    const rowSegments: string[] = [];
    for (const col of columns) {
      const line = col.lines[r] || ' '.repeat(col.width);
      const cleanW = visibleWidth(line);
      const pad = Math.max(0, col.width - cleanW);
      rowSegments.push(line + ' '.repeat(pad));
    }
    rows.push(rowSegments.join(' '));
  }
  return rows;
}

/**
 * 滚动视口容器 (ScrollView 辅助函数)
 */
export function renderScrollView(lines: string[], viewHeight: number, scrollOffset: number): string[] {
  const offset = Math.max(0, Math.min(scrollOffset, Math.max(0, lines.length - viewHeight)));
  const visible = lines.slice(offset, offset + viewHeight);
  while (visible.length < viewHeight) {
    visible.push('');
  }
  return visible;
}
