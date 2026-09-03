/**
 * 终端 UI 核心循环引擎
 * 支持差量渲染、硬件光标定位 (CURSOR_MARKER)、多层级 9 锚点 Overlay 浮层合成与键盘事件分发。
 */

import { type CursorPosition, extractCursorPosition } from './cursor.js';
import { type KeyEvent, parseKey } from './keys.js';
import type { Component } from './layout.js';
import { type OverlayHandle, OverlayManager, type OverlayOptions } from './overlay.js';
import { ANSI, DifferentialRenderer, type ScreenDimensions } from './render.js';
import { ProcessTerminal, type Terminal } from './terminal.js';
import { ScreenManager } from './tui-screens.js';

export interface TuiOptions {
  altScreen?: boolean;
  onKey?: (key: KeyEvent) => void;
  rootComponent?: Component;
  /** 终端 I/O 端口，默认包裹 process.stdout 的 ProcessTerminal。 */
  terminal?: Terminal;
}

interface KeyHandler {
  handleKey(key: KeyEvent): boolean;
}

function hasKeyHandler(component: Component): component is Component & KeyHandler {
  return typeof (component as { handleKey?: unknown }).handleKey === 'function';
}

export class TUI {
  public differentialRenderer = new DifferentialRenderer();
  public overlayManager = new OverlayManager();
  public rootComponent?: Component;
  public onKey?: (key: KeyEvent) => void;
  public lastCursorPosition: CursorPosition | null = null;
  public screenManager: ScreenManager;
  private terminal: Terminal;
  private isRunning = false;
  private resizeListener?: () => void;

  constructor(options: TuiOptions = {}) {
    this.terminal = options.terminal ?? new ProcessTerminal();
    this.screenManager = new ScreenManager(this.terminal);
    if (options.altScreen) {
      this.screenManager.enterAltScreen();
    }
    this.rootComponent = options.rootComponent;
    this.onKey = options.onKey;
  }

  public getDimensions(): ScreenDimensions {
    return {
      cols: this.terminal.columns,
      rows: this.terminal.rows
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
    this.terminal.onResize(this.resizeListener);
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
      this.terminal.offResize(this.resizeListener);
    }

    this.screenManager.leaveAltScreen();
  }

  private handleInputBuffer = (data: Buffer): void => {
    this.handleInput(data);
  };

  public handleInput(data: Buffer | string): void {
    const key = parseKey(data);
    const activeOverlay = this.overlayManager.getActiveOverlay();

    if (activeOverlay?.options.modal) {
      // Route input to modal overlay first if supported
      if (hasKeyHandler(activeOverlay.component)) {
        const handled = activeOverlay.component.handleKey(key);
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
        this.terminal.write(ANSI.CURSOR_HOME + output);
      } else {
        this.terminal.write(`${output}\n`);
      }
    }

    // Position hardware cursor for IME candidate alignment
    if (cursor) {
      this.terminal.write(`\x1b[${cursor.row};${cursor.col}H${ANSI.CURSOR_SHOW}`);
    }
  }
}
