import { BoxComponent, MemoryTerminal, TUI } from '@inkpi/tui';
import { describe, expect, it } from 'vitest';

/**
 * C5 守卫测试：`TUI` 的终端 I/O 通过可注入的 `Terminal` 端口，
 * 默认 `ProcessTerminal`（包裹 process.stdout），测试可注入 `MemoryTerminal` 且不触碰真实终端。
 */
describe('TUI Terminal port injection (C5)', () => {
  it('routes getDimensions() through the injected terminal', () => {
    const term = new MemoryTerminal();
    term.columns = 100;
    term.rows = 40;
    const tui = new TUI({ terminal: term, rootComponent: new BoxComponent({ content: ['hi'] }) });
    expect(tui.getDimensions()).toEqual({ cols: 100, rows: 40 });
  });

  it('refresh() writes through the injected terminal (not process.stdout)', () => {
    const term = new MemoryTerminal();
    const tui = new TUI({ terminal: term, rootComponent: new BoxComponent({ content: ['hello'] }) });
    tui.refresh();
    expect(term.writes.length).toBeGreaterThan(0);
    expect(term.writes.join('')).toContain('hello');
  });

  it('subscribes/unsubscribes resize through the injected terminal', () => {
    const term = new MemoryTerminal();
    const tui = new TUI({ terminal: term, rootComponent: new BoxComponent({ content: ['x'] }) });
    tui.start();
    expect(term.resizeListeners.size).toBe(1);
    tui.stop();
    expect(term.resizeListeners.size).toBe(0);
  });
});
