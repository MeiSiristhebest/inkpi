import { describe, it, expect } from 'vitest';
import {
  visibleWidth,
  sliceWithWidth,
  CURSOR_MARKER,
  extractCursorPosition,
  OverlayManager,
  Component,
  type RenderContext,
  padOrTruncateLine,
  Editor
} from '../packages/tui/src/index.js';

class MockModalBox extends Component {
  constructor(private title: string, private text: string) {
    super();
  }

  public render(context: RenderContext): string[] {
    const { width, height } = context;
    const lines: string[] = [];
    lines.push(`┌ ${this.title} ${'─'.repeat(Math.max(0, width - this.title.length - 4))}┐`);
    lines.push(`│ ${this.text.padEnd(width - 4)} │`);
    while (lines.length < height - 1) {
      lines.push(`│ ${' '.repeat(width - 4)} │`);
    }
    lines.push(`└${'─'.repeat(width - 2)}┘`);
    return lines;
  }
}

describe('TUI Hardware Cursor, Wide Characters & Overlay System (Aligned with Pi)', () => {
  it('should accurately calculate column width for Chinese characters, fullwidth punctuation and Emoji', () => {
    expect(visibleWidth('Hello')).toBe(5);
    expect(visibleWidth('你好世界')).toBe(8);
    expect(visibleWidth('《斗破苍穹》')).toBe(12);
    expect(visibleWidth('全角空格　缩进')).toBe(14); // 4 + 2 + 4 = 10 + 4 = 14
    expect(visibleWidth('\x1b[31m红字\x1b[0m')).toBe(4); // ANSI stripped
  });

  it('should slice text precisely with ANSI awareness and wide character protection', () => {
    const text = '\x1b[32m林玄拔剑而起\x1b[0m，天地变色！';
    const sliced = sliceWithWidth(text, 0, 8); // 8 columns = 4 Chinese characters: "林玄拔剑"
    expect(visibleWidth(sliced)).toBe(8);
  });

  it('should extract CURSOR_MARKER and accurately calculate physical hardware cursor coordinates', () => {
    const lines = [
      '第一行 标题栏',
      `第二行 输入正文: 林玄手持\x1b_pi:c\x07青锋剑`,
      '第三行 状态栏'
    ];

    const { cleanedLines, cursor } = extractCursorPosition(lines);

    expect(cursor).not.toBeNull();
    expect(cursor?.row).toBe(2);
    // "第二行 输入正文: 林玄手持" = 6 + 1 + 8 + 1 + 8 = 24 cols. Next col = 25
    expect(cursor?.col).toBe(visibleWidth('第二行 输入正文: 林玄手持') + 1);
    expect(cleanedLines[1]).toBe('第二行 输入正文: 林玄手持青锋剑');
  });

  it('should position CURSOR_MARKER inside Editor render output', () => {
    const editor = new Editor({ text: '天地玄黄\n宇宙洪荒' });
    editor.cursorRow = 1;
    editor.cursorCol = 2; // after '宇宙'

    const rendered = editor.render({ width: 40, height: 5 });
    const { cursor } = extractCursorPosition(rendered);

    expect(cursor).not.toBeNull();
    expect(cursor?.row).toBe(2);
  });

  it('should composite 9-anchor floating overlays over background content', () => {
    const overlayManager = new OverlayManager();
    const modal = new MockModalBox('设定速查', '九霄神雷诀: 天阶功法');

    overlayManager.show(modal, {
      id: 'lore_drawer',
      anchor: 'center',
      width: 30,
      height: 4,
      modal: true
    });

    expect(overlayManager.hasOverlays()).toBe(true);
    expect(overlayManager.getActiveOverlay()?.id).toBe('lore_drawer');

    const baseLines = [
      '正文行 001: 萧寒凝神静气，运转体内灵力。',
      '正文行 002: 丹田之内，金色元婴缓缓盘旋。',
      '正文行 003: 忽然天际雷云密布，威压阵阵。',
      '正文行 004: 这一刻，整个青云宗为之震动。',
      '正文行 005: 掌教真人御剑而来，神色肃穆。'
    ];

    const composited = overlayManager.composite(baseLines, 60, 6);

    expect(composited).toHaveLength(6);
    // Modal title should appear in composited output
    const joinedText = composited.join('\n');
    expect(joinedText).toContain('设定速查');
    expect(joinedText).toContain('九霄神雷诀');

    overlayManager.hide('lore_drawer');
    expect(overlayManager.hasOverlays()).toBe(false);
  });
});
