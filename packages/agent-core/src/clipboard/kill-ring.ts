/**
 * Emacs 风格 Kill-Ring 多级剪贴板环 (1:1 移植自 repos/pi packages/tui/src/kill-ring.ts)
 * 防止作家误删重要灵感段落，支持无限级旋转找回
 */
export class KillRing {
  private ring: string[] = [];
  private maxEntries: number;
  private pointer = 0;

  constructor(maxEntries = 60) {
    this.maxEntries = maxEntries;
  }

  /**
   * 压入新的剪切文本块
   */
  public push(text: string): void {
    if (!text) return;
    // If consecutive kill on top, can append or add new entry
    this.ring.unshift(text);
    if (this.ring.length > this.maxEntries) {
      this.ring.pop();
    }
    this.pointer = 0;
  }

  /**
   * 获取当前剪贴板顶部内容 (Yank)
   */
  public peek(): string | undefined {
    if (this.ring.length === 0) return undefined;
    return this.ring[this.pointer];
  }

  /**
   * 旋转剪贴板指针至前一项 (Yank-Pop / Cycle)
   */
  public rotate(): string | undefined {
    if (this.ring.length === 0) return undefined;
    this.pointer = (this.pointer + 1) % this.ring.length;
    return this.ring[this.pointer];
  }

  public getAll(): string[] {
    return [...this.ring];
  }

  public size(): number {
    return this.ring.length;
  }

  public clear(): void {
    this.ring = [];
    this.pointer = 0;
  }
}
