/**
 * 终端 I/O 端口（依赖反转）。
 *
 * 原先 `tui.ts` / `tui-screens.ts` 直接耦合 `process.stdout`（`write` / `columns` / `rows` /
 * `resize` 事件），难以在测试或非 TTY 环境中注入替身。抽出 `Terminal` 端口后，
 * 生产默认用 `ProcessTerminal`（包裹 `process.stdout`），测试可注入 `MemoryTerminal`。
 */

export interface Terminal {
  /** 当前终端列数（非 TTY 时降级为回退值）。 */
  readonly columns: number;
  /** 当前终端行数（非 TTY 时降级为回退值）。 */
  readonly rows: number;
  /** 向终端写入原始字节/转义序列。 */
  write(data: string): void;
  /** 订阅终端尺寸变化（'resize'）。 */
  onResize(listener: () => void): void;
  /** 取消订阅终端尺寸变化。 */
  offResize(listener: () => void): void;
}

/** 生产默认实现：直接包裹 `process.stdout`。 */
export class ProcessTerminal implements Terminal {
  public get columns(): number {
    return process.stdout.columns || 80;
  }

  public get rows(): number {
    return process.stdout.rows || 24;
  }

  public write(data: string): void {
    process.stdout.write(data);
  }

  public onResize(listener: () => void): void {
    process.stdout.on('resize', listener);
  }

  public offResize(listener: () => void): void {
    process.stdout.removeListener('resize', listener);
  }
}

/** 内存替身：记录所有写入与 resize 订阅，供测试断言（不触碰真实终端）。 */
export class MemoryTerminal implements Terminal {
  public writes: string[] = [];
  public columns = 80;
  public rows = 24;
  public resizeListeners = new Set<() => void>();

  public write(data: string): void {
    this.writes.push(data);
  }

  public onResize(listener: () => void): void {
    this.resizeListeners.add(listener);
  }

  public offResize(listener: () => void): void {
    this.resizeListeners.delete(listener);
  }
}
