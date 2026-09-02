/**
 * 硬件光标定位机制
 * 使用 APC (Application Program Command) 不可见转义序列标记光标位置，
 * TUI 差量渲染器解析该标记，并在终端中准确定位硬件光标，使拼音输入法候选框精确停留在光标下方。
 */

import { visibleWidth } from './width.js';

export const CURSOR_MARKER = '\x1b_pi:c\x07';

export interface Focusable {
  focused: boolean;
}

export function isFocusable(component: unknown): component is Focusable {
  return component !== null && typeof component === 'object' && 'focused' in component;
}

export interface CursorPosition {
  row: number;
  col: number;
}

/**
 * 从渲染输出的文本行中查找 CURSOR_MARKER 并计算物理行列坐标
 */
export function extractCursorPosition(lines: string[]): {
  cleanedLines: string[];
  cursor: CursorPosition | null;
} {
  let cursor: CursorPosition | null = null;
  const cleanedLines: string[] = [];

  for (let rowIndex = 0; rowIndex < lines.length; rowIndex++) {
    const line = lines[rowIndex]!;
    const markerIndex = line.indexOf(CURSOR_MARKER);

    if (markerIndex !== -1 && cursor === null) {
      const beforeMarker = line.slice(0, markerIndex);
      const afterMarker = line.slice(markerIndex + CURSOR_MARKER.length);
      const col = visibleWidth(beforeMarker) + 1; // 1-indexed for terminal ANSI cursor
      cursor = {
        row: rowIndex + 1,
        col
      };
      cleanedLines.push(beforeMarker + afterMarker);
    } else {
      // Clean any accidental duplicate markers
      cleanedLines.push(line.replaceAll(CURSOR_MARKER, ''));
    }
  }

  return { cleanedLines, cursor };
}
