/**
 * 终端 UI 核心循环引擎 (1:1 对标 pi-tui tui.ts)
 */

import { DifferentialRenderer, type ScreenDimensions, ANSI } from './render.js';
import { ScreenManager } from './tui-screens.js';
import { parseKey, type KeyEvent } from './keys.js';
import { Component } from './layout.js';

export interface TuiOptions {
  altScreen?: boolean;
  onKey?: (key: KeyEvent) => void;
  rootComponent?: Component;
}

export class TUI {
  public differentialRenderer = new DifferentialRenderer();
  public screenManager = new ScreenManager();
  public rootComponent?: Component;
  public onKey?: (key: KeyEvent) => void;
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
    if (this.onKey) {
      this.onKey(key);
    }
    this.refresh();
  }

  public refresh(): void {
    if (!this.rootComponent) return;
    const dim = this.getDimensions();
    const renderedLines = this.rootComponent.render({ width: dim.cols, height: dim.rows });
    const screenText = renderedLines.join('\n');
    const { changedLines, output } = this.differentialRenderer.render(screenText);

    if (changedLines > 0) {
      if (this.screenManager.getMode() === 'alt') {
        process.stdout.write(ANSI.CURSOR_HOME + output);
      } else {
        process.stdout.write(output + '\n');
      }
    }
  }
}
