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

  it('uses row patches in alt-screen mode and keeps full-frame writes in inline mode', () => {
    const altRoot = new BoxComponent({ content: ['unchanged top', 'before', 'unchanged bottom'] });

    const altTerminal = new MemoryTerminal();
    const altTui = new TUI({ altScreen: true, terminal: altTerminal, rootComponent: altRoot });
    altTui.refresh();
    altRoot.content[1] = 'after';
    altTui.refresh();

    const patch = altTerminal.writes.at(-1) ?? '';
    expect(patch).toContain('\x1b[3;1H\x1b[2K\x1b[36m│\x1b[0mafter');
    expect(patch).not.toContain('unchanged top');
    expect(patch).not.toContain('unchanged bottom');

    const inlineRoot = new BoxComponent({ content: ['unchanged top', 'before', 'unchanged bottom'] });
    const inlineTerminal = new MemoryTerminal();
    const inlineTui = new TUI({ terminal: inlineTerminal, rootComponent: inlineRoot });
    inlineTui.refresh();
    inlineRoot.content[1] = 'after';
    inlineTui.refresh();

    const fullFrame = inlineTerminal.writes.at(-1) ?? '';
    expect(fullFrame).toContain('after');
    expect(fullFrame).toContain('unchanged top');
    expect(fullFrame).toContain('unchanged bottom');
    expect(fullFrame).not.toContain('\x1b[2;1H');
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
