/**
 * 主屏幕与备用全屏管理器
 */

import { ANSI } from './render.js';

export type ScreenMode = 'main' | 'alt';

export class ScreenManager {
  private mode: ScreenMode = 'main';

  public enterAltScreen(): void {
    if (this.mode !== 'alt') {
      process.stdout.write(ANSI.ALT_SCREEN_ENTER + ANSI.CURSOR_HIDE + ANSI.CURSOR_HOME);
      this.mode = 'alt';
    }
  }

  public leaveAltScreen(): void {
    if (this.mode === 'alt') {
      process.stdout.write(ANSI.ALT_SCREEN_LEAVE + ANSI.CURSOR_SHOW);
      this.mode = 'main';
    }
  }

  public getMode(): ScreenMode {
    return this.mode;
  }
}
