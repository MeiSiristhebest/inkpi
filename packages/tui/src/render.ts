/**
 * InkPi TUI 差量渲染与 ANSI 样式生成器 (1:1 对标 pi-tui)
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

/**
 * 剥离 ANSI 转义字符
 */
export function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b_[^\x1b]*\x1b\\/g, '');
}

/**
 * 计算终端可视化列宽 (1:1 对标 pi visibleWidth)
 * 中文字符、全角标点占用 2 列，普通 ASCII 占用 1 列，ANSI 转义符占用 0 列。
 */
export function visibleWidth(str: string): number {
  const clean = stripAnsi(str);
  let width = 0;
  for (let i = 0; i < clean.length; i++) {
    const code = clean.charCodeAt(i);
    // CJK Unified Ideographs, Fullwidth Forms, Japanese/Korean characters, Emoji
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x20000 && code <= 0x2a6df) ||
      (code >= 0xff01 && code <= 0xff60) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0x1f300 && code <= 0x1f9ff)
    ) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * 按终端可视列宽截断字符串 (1:1 对标 pi truncateToWidth)
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
 * 差量渲染缓冲计算器 (1:1 对标 pi-tui DifferentialRenderer)
 */
export class DifferentialRenderer {
  private lastBuffer: string[] = [];

  public render(newScreenText: string): { changedLines: number; output: string } {
    const currentLines = newScreenText.split('\n');
    let changed = 0;

    for (let i = 0; i < currentLines.length; i++) {
      if (this.lastBuffer[i] !== currentLines[i]) {
        changed++;
      }
    }

    this.lastBuffer = [...currentLines];
    return { changedLines: changed, output: newScreenText };
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
