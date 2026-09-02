/**
 * 多层级 9 锚点浮动 Overlay 弹窗系统
 * 支持中心模态、边缘抽屉、光标锚定悬浮菜单与键盘焦点管理。
 */

import type { Component, RenderContext } from './layout.js';

import { padOrTruncateLine, sliceWithWidth, visibleWidth } from './width.js';

export type OverlayAnchor =
  | 'center'
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right'
  | 'left-center'
  | 'right-center';

export interface OverlayMargin {
  top?: number;
  right?: number;
  bottom?: number;
  left?: number;
}

export interface OverlayOptions {
  id?: string;
  anchor?: OverlayAnchor;
  width?: number; // Physical column width
  height?: number; // Row height
  margin?: OverlayMargin;
  modal?: boolean;
  onClose?: () => void;
}

export class OverlayHandle {
  public id: string;
  public component: Component;
  public options: Required<OverlayOptions>;

  constructor(component: Component, options: OverlayOptions = {}) {
    this.id = options.id || `overlay_${Math.random().toString(36).slice(2, 9)}`;
    this.component = component;
    this.options = {
      id: this.id,
      anchor: options.anchor || 'center',
      width: options.width || 40,
      height: options.height || 10,
      margin: options.margin || { top: 1, bottom: 1, left: 2, right: 2 },
      modal: options.modal ?? true,
      onClose: options.onClose || (() => {})
    };
  }
}

export class OverlayManager {
  private overlays: OverlayHandle[] = [];

  public show(component: Component, options: OverlayOptions = {}): OverlayHandle {
    const handle = new OverlayHandle(component, options);
    this.overlays.push(handle);
    return handle;
  }

  public hide(handleOrId: OverlayHandle | string): boolean {
    const id = typeof handleOrId === 'string' ? handleOrId : handleOrId.id;
    const idx = this.overlays.findIndex((o) => o.id === id);
    if (idx !== -1) {
      const [removed] = this.overlays.splice(idx, 1);
      removed?.options.onClose();
      return true;
    }
    return false;
  }

  public getActiveOverlay(): OverlayHandle | undefined {
    return this.overlays[this.overlays.length - 1];
  }

  public hasOverlays(): boolean {
    return this.overlays.length > 0;
  }

  /**
   * 将浮层渲染合成至底图文本行
   */
  public composite(baseLines: string[], screenWidth: number, screenHeight: number): string[] {
    if (this.overlays.length === 0) return baseLines;

    const result = [...baseLines];
    // Ensure result array has screenHeight lines
    while (result.length < screenHeight) {
      result.push(' '.repeat(screenWidth));
    }

    for (const overlay of this.overlays) {
      const { anchor, width: rawW, height: rawH, margin } = overlay.options;
      const overlayWidth = Math.min(rawW, screenWidth - (margin.left || 0) - (margin.right || 0));
      const overlayHeight = Math.min(rawH, screenHeight - (margin.top || 0) - (margin.bottom || 0));

      const overlayLines = overlay.component.render({ width: overlayWidth, height: overlayHeight });

      // Calculate startRow and startCol based on anchor
      let startRow = 0;
      let startCol = 0;

      const marginTop = margin.top || 0;
      const marginBottom = margin.bottom || 0;
      const marginLeft = margin.left || 0;
      const marginRight = margin.right || 0;

      const availableRows = screenHeight - marginTop - marginBottom;
      const availableCols = screenWidth - marginLeft - marginRight;

      switch (anchor) {
        case 'center':
          startRow = marginTop + Math.max(0, Math.floor((availableRows - overlayHeight) / 2));
          startCol = marginLeft + Math.max(0, Math.floor((availableCols - overlayWidth) / 2));
          break;
        case 'top-left':
          startRow = marginTop;
          startCol = marginLeft;
          break;
        case 'top-center':
          startRow = marginTop;
          startCol = marginLeft + Math.max(0, Math.floor((availableCols - overlayWidth) / 2));
          break;
        case 'top-right':
          startRow = marginTop;
          startCol = Math.max(0, screenWidth - marginRight - overlayWidth);
          break;
        case 'bottom-left':
          startRow = Math.max(0, screenHeight - marginBottom - overlayHeight);
          startCol = marginLeft;
          break;
        case 'bottom-center':
          startRow = Math.max(0, screenHeight - marginBottom - overlayHeight);
          startCol = marginLeft + Math.max(0, Math.floor((availableCols - overlayWidth) / 2));
          break;
        case 'bottom-right':
          startRow = Math.max(0, screenHeight - marginBottom - overlayHeight);
          startCol = Math.max(0, screenWidth - marginRight - overlayWidth);
          break;
        case 'left-center':
          startRow = marginTop + Math.max(0, Math.floor((availableRows - overlayHeight) / 2));
          startCol = marginLeft;
          break;
        case 'right-center':
          startRow = marginTop + Math.max(0, Math.floor((availableRows - overlayHeight) / 2));
          startCol = Math.max(0, screenWidth - marginRight - overlayWidth);
          break;
      }

      // Blit overlay lines over base lines
      for (let r = 0; r < overlayLines.length; r++) {
        const targetRow = startRow + r;
        if (targetRow < 0 || targetRow >= screenHeight) continue;

        const baseLine = result[targetRow] || '';
        const overlayLine = padOrTruncateLine(overlayLines[r] || '', overlayWidth);

        const leftSegment = sliceWithWidth(baseLine, 0, startCol);
        const paddedLeft = padOrTruncateLine(leftSegment, startCol);
        const rightStart = startCol + overlayWidth;
        const rightSegment = sliceWithWidth(baseLine, rightStart, Math.max(0, screenWidth - rightStart));

        result[targetRow] = paddedLeft + overlayLine + rightSegment;
      }
    }

    return result;
  }
}
