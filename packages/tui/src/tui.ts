/**
 * 终端 UI 核心循环引擎 (1:1 对标 pi-tui tui.ts)
 * 支持差量渲染、硬件光标定位 (CURSOR_MARKER)、多层级 9 锚点 Overlay 浮层合成与键盘事件分发。
 */

import { DifferentialRenderer, type ScreenDimensions, ANSI } from './render.js';
import { ScreenManager } from './tui-screens.js';
import { parseKey, type KeyEvent } from './keys.js';
import { Component } from './layout.js';
import { OverlayManager, type OverlayOptions, OverlayHandle } from './overlay.js';
import { extractCursorPosition, type CursorPosition } from './cursor.js';

export interface TuiOptions {
  altScreen?: boolean;
  onKey?: (key: KeyEvent) => void;
  rootComponent?: Component;
}

export class TUI {
  public differentialRenderer = new DifferentialRenderer();
  public screenManager = new ScreenManager();
  public overlayManager = new OverlayManager();
  public rootComponent?: Component;
  public onKey?: (key: KeyEvent) => void;
  public lastCursorPosition: CursorPosition | null = null;
  private isRunning = false;
  private resizeListener?: () => void;

  constructor(options: TuiOptions = {}) {
    if (options.altScreen) {
      this.screenManager.enterAltScreen();
    }
    this.rootComponent = options.rootComponent;
    this.onKey = options.onKey;
  }

  public getDimensions(): ScreenDimensions {
    return {
      cols: process.stdout.columns || 80,
      rows: process.stdout.rows || 24
    };
  }

  public showOverlay(component: Component, options: OverlayOptions = {}): OverlayHandle {
    const handle = this.overlayManager.show(component, options);
    this.refresh();
    return handle;
  }

  public hideOverlay(handleOrId: OverlayHandle | string): boolean {
    const res = this.overlayManager.hide(handleOrId);
    if (res) {
      this.refresh();
    }
    return res;
  }

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('data', this.handleInputBuffer);
    }

    this.resizeListener = () => {
      this.refresh();
    };
    process.stdout.on('resize', this.resizeListener);
    this.refresh();
  }

  public stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (process.stdin.isTTY) {
      process.stdin.removeListener('data', this.handleInputBuffer);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    }

    if (this.resizeListener) {
      process.stdout.removeListener('resize', this.resizeListener);
    }

    this.screenManager.leaveAltScreen();
  }

  private handleInputBuffer = (data: Buffer): void => {
    this.handleInput(data);
  };

  public handleInput(data: Buffer | string): void {
    const key = parseKey(data);
    const activeOverlay = this.overlayManager.getActiveOverlay();

    if (activeOverlay && activeOverlay.options.modal) {
      // Route input to modal overlay first if supported
      if ('handleKey' in activeOverlay.component && typeof (activeOverlay.component as any).handleKey === 'function') {
        const handled = (activeOverlay.component as any).handleKey(key);
        if (handled) {
          this.refresh();
          return;
        }
      }
      if (key.name === 'escape') {
        this.hideOverlay(activeOverlay);
        return;
      }
    }

    if (this.onKey) {
      this.onKey(key);
    }
    this.refresh();
  }

  public refresh(): void {
    if (!this.rootComponent) return;
    const dim = this.getDimensions();
    const rawRenderedLines = this.rootComponent.render({ width: dim.cols, height: dim.rows });

    // Composite overlay floating layers
    const compositedLines = this.overlayManager.composite(rawRenderedLines, dim.cols, dim.rows);

    // Extract CURSOR_MARKER and clean output
    const { cleanedLines, cursor } = extractCursorPosition(compositedLines);
    this.lastCursorPosition = cursor;

    const screenText = cleanedLines.join('\n');
    const { changedLines, output } = this.differentialRenderer.render(screenText);

    if (changedLines > 0) {
      if (this.screenManager.getMode() === 'alt') {
        process.stdout.write(ANSI.CURSOR_HOME + output);
      } else {
        process.stdout.write(output + '\n');
      }
    }

    // Position hardware cursor for IME candidate alignment
    if (cursor) {
      process.stdout.write(`\x1b[${cursor.row};${cursor.col}H${ANSI.CURSOR_SHOW}`);
    }
  }
}
