/**
 * 主屏幕与备用全屏管理器
 */

import { ANSI } from './render.js';
import type { Terminal } from './terminal.js';
import { ProcessTerminal } from './terminal.js';

export type ScreenMode = 'main' | 'alt';

export class ScreenManager {
  private mode: ScreenMode = 'main';
  private terminal: Terminal;

  constructor(terminal: Terminal = new ProcessTerminal()) {
    this.terminal = terminal;
  }

  public enterAltScreen(): void {
    if (this.mode !== 'alt') {
      this.terminal.write(ANSI.ALT_SCREEN_ENTER + ANSI.CURSOR_HIDE + ANSI.CURSOR_HOME);
      this.mode = 'alt';
    }
  }

  public leaveAltScreen(): void {
    if (this.mode === 'alt') {
      this.terminal.write(ANSI.ALT_SCREEN_LEAVE + ANSI.CURSOR_SHOW);
      this.mode = 'main';
    }
  }

  public getMode(): ScreenMode {
    return this.mode;
  }
}
