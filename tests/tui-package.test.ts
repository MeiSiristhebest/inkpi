import { describe, it, expect } from 'vitest';
import {
  visibleWidth,
  stripAnsi,
  truncateToWidth,
  drawBox,
  DifferentialRenderer,
  parseKey,
  Box,
  HStack,
  VStack,
  Spacer,
  ScrollView,
  Editor,
  SelectList,
  Markdown,
  renderTerminalImage,
  detectTerminalProtocol,
  TerminalMermaid,
  ScreenManager,
  TUI,
  ANSI,
  layoutHStack,
  layoutVStack,
  renderScrollView
} from '@meisiristhebest/tui';
import { Box as CompBox } from '../packages/tui/src/components/box.js';
import { HStack as CompHStack } from '../packages/tui/src/components/h-stack.js';
import { VStack as CompVStack } from '../packages/tui/src/components/v-stack.js';
import { Spacer as CompSpacer } from '../packages/tui/src/components/spacer.js';

describe('@meisiristhebest/tui Independent Framework', () => {
  it('should calculate visible width correctly with CJK, Fullwidth, and Emoji characters', () => {
    expect(visibleWidth('hello')).toBe(5);
    expect(visibleWidth('你好世界')).toBe(8);
    expect(visibleWidth('Hello，世界！')).toBe(13);
    expect(visibleWidth(`${ANSI.BOLD}测试${ANSI.RESET}`)).toBe(4);
    expect(visibleWidth('🌟')).toBe(2);
    expect(stripAnsi('\x1b[31mRed\x1b[0m')).toBe('Red');
  });

  it('should truncate strings to visible width correctly', () => {
    const text = '第一卷：长生之始，九域风云';
    const truncated = truncateToWidth(text, 10, '..');
    expect(visibleWidth(truncated)).toBeLessThanOrEqual(10);
    expect(truncated.endsWith('..')).toBe(true);

    expect(truncateToWidth('short', 10)).toBe('short');
    expect(truncateToWidth('short', 0)).toBe('');
  });

  it('should draw balanced ANSI boxes with CJK title and content', () => {
    const lines = drawBox('角色卡', ['名字: 叶孤辰', '境界: 筑基期三层'], 30, 6, ANSI.FG_CYAN);
    expect(lines.length).toBe(6);
    expect(lines[0]).toContain('角色卡');
    expect(lines[1]).toContain('叶孤辰');
    expect(lines[2]).toContain('筑基期三层');
  });

  it('should calculate differential render frames and dirty lines correctly', () => {
    const renderer = new DifferentialRenderer();
    const frame1 = renderer.render('Line 1\nLine 2\nLine 3');
    expect(frame1.changedLines).toBe(3);

    const frame2 = renderer.render('Line 1\nLine 2 (Modified)\nLine 3');
    expect(frame2.changedLines).toBe(1);

    const frame3 = renderer.render('Line 1\nLine 2 (Modified)\nLine 3');
    expect(frame3.changedLines).toBe(0);

    renderer.clear();
    const frame4 = renderer.render('Line 1\nLine 2\nLine 3');
    expect(frame4.changedLines).toBe(3);

    // Shrinking buffer (from 3 lines to 1 line) -> lines 2 & 3 cleared
    const frameShrink = renderer.render('Line 1');
    expect(frameShrink.changedLines).toBe(2);
    expect(frameShrink.diffAnsi).toContain('\x1b[2;1H\x1b[2K');

    // renderScrollView padding test
    const paddedScroll = renderScrollView(['Item 1'], 3, 0);
    expect(paddedScroll.length).toBe(3);
    expect(paddedScroll[1]).toBe('');
    expect(paddedScroll[2]).toBe('');
  });

  it('should parse terminal keys and modifiers correctly', () => {
    expect(parseKey('\r').name).toBe('enter');
    expect(parseKey('\n').name).toBe('enter');
    expect(parseKey('\t').name).toBe('tab');
    expect(parseKey('\x1b[Z').shift).toBe(true);
    expect(parseKey('\x7f').name).toBe('backspace');
    expect(parseKey('\x08').name).toBe('backspace');
    expect(parseKey('\x1b').name).toBe('escape');
    expect(parseKey(' ').name).toBe('space');
    expect(parseKey('\x1b[A').name).toBe('up');
    expect(parseKey('\x1b[B').name).toBe('down');
    expect(parseKey('\x1b[C').name).toBe('right');
    expect(parseKey('\x1b[D').name).toBe('left');
    expect(parseKey('\x1b[H').name).toBe('home');
    expect(parseKey('\x1b[F').name).toBe('end');
    expect(parseKey('\x1b[5~').name).toBe('pageup');
    expect(parseKey('\x1b[6~').name).toBe('pagedown');
    expect(parseKey('\x1b[3~').name).toBe('delete');
    expect(parseKey('\x1bOP').name).toBe('f1');
    expect(parseKey('\x1bOQ').name).toBe('f2');
    expect(parseKey('\x1bOR').name).toBe('f3');
    expect(parseKey('\x1bOS').name).toBe('f4');
    expect(parseKey('\x1ba').meta).toBe(true);
    expect(parseKey('\x03').name).toBe('c');
    expect(parseKey('\x03').ctrl).toBe(true);
  });

  it('should render layout components Box, HStack, VStack, and Spacer', () => {
    const box1 = new Box({ title: '左栏', content: ['分卷 1', '分卷 2'] });
    const box2 = new Box({ title: '右栏', content: ['正文内容'] });
    box1.addChild(new Spacer(1));
    expect(new CompBox({ title: 't' })).toBeDefined();
    expect(new CompHStack()).toBeDefined();
    expect(new CompVStack()).toBeDefined();
    expect(new CompSpacer(1)).toBeDefined();

    const hstack = new HStack();
    hstack.add(box1, 20);
    hstack.add(box2);

    const hLines = hstack.render({ width: 51, height: 6 });
    expect(hLines.length).toBe(6);
    expect(hLines[0]).toContain('左栏');

    const vstack = new VStack();
    vstack.add(box1, 4);
    vstack.add(new Spacer(1));
    vstack.add(box2);

    const vLines = vstack.render({ width: 40, height: 9 });
    expect(vLines.length).toBe(9);

    // Helpers
    expect(layoutVStack([['a'], ['b']])).toEqual(['a', 'b']);
    expect(layoutHStack([{ lines: ['a'], width: 5 }], 1).length).toBe(1);
    expect(renderScrollView(['1', '2', '3'], 2, 1).length).toBe(2);

    // VStack: trigger SpacerComponent branch (child.component instanceof SpacerComponent)
    const vstackSpacer = new VStack();
    vstackSpacer.add(box2); // no explicit height, not spacer => uses flex
    vstackSpacer.add(new Spacer(2)); // instanceof SpacerComponent
    const vstackLines = vstackSpacer.render({ width: 40, height: 8 });
    expect(vstackLines.length).toBe(8);

    // VStack: trigger while (result.length < height) padding branch
    const vstackSmall = new VStack();
    vstackSmall.add(box1, 2);
    const vstackSmallLines = vstackSmall.render({ width: 40, height: 10 });
    expect(vstackSmallLines.length).toBe(10);

    // HStack: trigger r >= col.lines.length (spacer fill branch)
    const hstackSparse = new HStack();
    hstackSparse.add(new Spacer(1), 5);
    hstackSparse.add(box1, 10);
    const hLines2 = hstackSparse.render({ width: 30, height: 5 });
    expect(hLines2.length).toBe(5);

    // Box: render with children (child path, not content)
    const containerBox = new Box({ title: '外', flex: 2 });
    containerBox.addChild(new Spacer(1));
    const containerLines = containerBox.render({ width: 30, height: 5 });
    expect(containerLines.length).toBe(5);
  });

  it('should manage ScrollView scrolling and scrollbars', () => {
    const content = Array.from({ length: 20 }, (_, i) => `章节列表项 ${i + 1}`);
    const scrollView = new ScrollView({ content, showScrollbar: true });

    const page1 = scrollView.render({ width: 30, height: 5 });
    expect(page1.length).toBe(5);
    expect(page1[0]).toContain('章节列表项 1');

    scrollView.scrollBy(5, 5);
    const page2 = scrollView.render({ width: 30, height: 5 });
    expect(page2[0]).toContain('章节列表项 6');

    scrollView.scrollBy(-10);
    expect(scrollView.scrollOffset).toBe(0);

    scrollView.scrollTo(0);
    expect(scrollView.scrollOffset).toBe(0);

    scrollView.setContent(['短列表']);
    const shortPage = scrollView.render({ width: 20, height: 4 });
    expect(shortPage.length).toBe(4);
  });

  it('should handle Editor all edge cases and boundary movements', () => {
    const editor = new Editor({ text: 'Line1\nLine2\nLine3\nLine4\nLine5\nLine6', showLineNumbers: true });
    expect(editor.getText()).toContain('Line1');

    // Read only check
    editor.readOnly = true;
    expect(editor.handleKey(parseKey('a'))).toBe(false);
    editor.readOnly = false;

    // Move up when at top
    editor.cursorRow = 0;
    editor.cursorCol = 0;
    editor.handleKey(parseKey('\x1b[A'));
    expect(editor.cursorRow).toBe(0);

    // Left when at col 0
    editor.cursorRow = 1;
    editor.cursorCol = 0;
    editor.handleKey(parseKey('\x1b[D'));
    expect(editor.cursorRow).toBe(0);

    // Left when at (0, 0)
    editor.cursorRow = 0;
    editor.cursorCol = 0;
    editor.handleKey(parseKey('\x1b[D'));

    // Right when at end of line
    editor.cursorRow = 0;
    editor.cursorCol = 5;
    editor.handleKey(parseKey('\x1b[C'));
    expect(editor.cursorRow).toBe(1);
    expect(editor.cursorCol).toBe(0);

    // Right when at end of last line
    editor.cursorRow = 5;
    editor.cursorCol = 5;
    editor.handleKey(parseKey('\x1b[C'));

    // Down when at bottom
    editor.cursorRow = 5;
    editor.handleKey(parseKey('\x1b[B'));

    // Backspace at line start
    editor.cursorRow = 1;
    editor.cursorCol = 0;
    editor.handleKey(parseKey('\x7f'));

    // Backspace at (0, 0)
    editor.cursorRow = 0;
    editor.cursorCol = 0;
    editor.handleKey(parseKey('\x7f'));

    // Delete at end of line
    editor.cursorRow = 0;
    editor.cursorCol = editor.lines[0].length;
    editor.handleKey(parseKey('\x1b[3~'));

    // Delete at end of last line
    editor.cursorRow = editor.lines.length - 1;
    editor.cursorCol = editor.lines[editor.cursorRow].length;
    editor.handleKey(parseKey('\x1b[3~'));

    // Enter key (split line)
    editor.cursorRow = 0;
    editor.cursorCol = 2;
    editor.handleKey(parseKey('\r'));
    expect(editor.cursorRow).toBe(1);
    expect(editor.cursorCol).toBe(0);

    // End key
    editor.cursorRow = 0;
    editor.cursorCol = 0;
    editor.handleKey(parseKey('\x1b[F'));
    expect(editor.cursorCol).toBe(editor.lines[0].length);

    // Delete in middle of line (forward delete)
    editor.cursorRow = 0;
    editor.cursorCol = 0;
    editor.handleKey(parseKey('\x1b[3~'));

    // Delete at end of line (merge with next) 
    editor.cursorRow = 0;
    editor.cursorCol = editor.lines[0].length;
    if (editor.lines.length > 1) {
      editor.handleKey(parseKey('\x1b[3~'));
    }

    // Trigger scrolling down and up
    editor.cursorRow = 5;
    editor.render({ width: 40, height: 3 });
    editor.cursorRow = 0;
    editor.render({ width: 40, height: 3 });
  });

  it('should handle SelectList filtering, selection, and navigation branches', () => {
    let selectedItem: any = null;
    let cancelled = false;
    const list = new SelectList({
      title: '模型选择',
      items: [
        { id: 'deepseek', label: 'DeepSeek V3', description: '高性价比' },
        { id: 'claude', label: 'Claude 3.7 Sonnet', description: '长文主笔', disabled: true },
        { id: 'gemini', label: 'Gemini 2.5 Pro', description: '百万长上下文' }
      ],
      onSelect: (item) => {
        selectedItem = item;
      },
      onCancel: () => {
        cancelled = true;
      }
    });

    // Filter by description
    list.handleKey(parseKey('高'));
    expect(list.getFilteredItems().length).toBe(1);

    // Backspace filter query
    list.handleKey(parseKey('\x7f'));
    expect(list.getFilteredItems().length).toBe(3);

    // Up when at 0 (wraps to bottom)
    list.selectedIndex = 0;
    list.handleKey(parseKey('\x1b[A'));
    expect(list.selectedIndex).toBe(2);

    // Down when at bottom (wraps to 0)
    list.handleKey(parseKey('\x1b[B'));
    expect(list.selectedIndex).toBe(0);

    // Enter on enabled
    list.handleKey(parseKey('\r'));
    expect(selectedItem?.id).toBe('deepseek');

    // Enter on disabled
    selectedItem = null;
    list.selectedIndex = 1;
    list.handleKey(parseKey('\r'));
    expect(selectedItem).toBeNull();

    // Escape
    list.handleKey(parseKey('\x1b'));
    expect(cancelled).toBe(true);

    const rendered = list.render({ width: 40, height: 6 });
    expect(rendered.length).toBeGreaterThan(0);
  });

  it('should render Markdown styles and blocks', () => {
    const md = new Markdown('# 斗破苍穹\n## 第一章 陨落的天才\n### 萧家大殿\n> 这是引用内容\n- 列表项\n* 星号列表\n普通文本 **加粗** 和 `代码`\n```ts\nconst a = 1;\n```');
    md.setText(md.rawText);
    const lines = md.render({ width: 50, height: 12 });
    expect(lines.some((l) => l.includes('斗破苍穹'))).toBe(true);
    expect(lines.some((l) => l.includes('第一章'))).toBe(true);
    expect(lines.some((l) => l.includes('引用内容'))).toBe(true);
  });

  it('should generate Terminal Images for Kitty, iTerm2 and ASCII fallbacks', () => {
    const mockBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const kittyCode = renderTerminalImage(mockBase64, { protocol: 'kitty' });
    expect(kittyCode.startsWith('\x1b_Ga=T')).toBe(true);

    const itermCode = renderTerminalImage(mockBase64, { protocol: 'iterm2', width: 20, height: 10 });
    expect(itermCode.startsWith('\x1b]1337;File=inline=1')).toBe(true);

    const asciiFallback = renderTerminalImage(Buffer.from('test'), { protocol: 'ascii', width: 20, height: 5 });
    expect(asciiFallback).toContain('立绘/图像');

    expect(detectTerminalProtocol()).toBeDefined();
    expect(renderTerminalImage(mockBase64, { protocol: 'auto' })).toBeDefined();
  });

  it('should render Mermaid ASCII flowcharts', () => {
    const mermaid = `
    flowchart TD
      A[主角遇伏] --> B[掉落悬崖]
      B --> C[获得古老传承]
      C --> D[重回家族打脸]
    `;
    const lines = TerminalMermaid.renderAsciiFlowchart(mermaid);
    expect(lines.some((l) => l.includes('主角遇伏'))).toBe(true);
    expect(lines.some((l) => l.includes('掉落悬崖'))).toBe(true);
    expect(lines.some((l) => l.includes('获得古老传承'))).toBe(true);

    expect(TerminalMermaid.renderAsciiFlowchart('invalid').length).toBeGreaterThan(0);

    // Edge with label text (triggers edge.label branch)
    const mermaidWithLabel = `
    flowchart TD
      A[开始] -->|触发| B[结束]
    `;
    const labelLines = TerminalMermaid.renderAsciiFlowchart(mermaidWithLabel);
    expect(labelLines.some((l) => l.includes('触发'))).toBe(true);

    // Node already in map (fromLabel falsy but node exists) — hit both branches
    const mermaidRevisit = `
    flowchart LR
      X[起点] --> Y[终点]
      X --> Z[分支]
    `;
    const revisitLines = TerminalMermaid.renderAsciiFlowchart(mermaidRevisit);
    expect(revisitLines.some((l) => l.includes('起点'))).toBe(true);

    // %% comment line (should be skipped)
    const mermaidComment = `
    flowchart TD
    %% 这是注释
    A[A] --> B[B]
    `;
    expect(TerminalMermaid.renderAsciiFlowchart(mermaidComment).length).toBeGreaterThan(0);
  });

  it('should handle ScreenManager and TUI lifecycle', () => {
    const sm = new ScreenManager();
    expect(sm.getMode()).toBe('main');
    sm.enterAltScreen();
    expect(sm.getMode()).toBe('alt');
    sm.leaveAltScreen();
    expect(sm.getMode()).toBe('main');

    let keyHit = false;
    const tui = new TUI({
      altScreen: true,
      rootComponent: new Box({ title: '根容器', content: ['内容'] }),
      onKey: () => {
        keyHit = true;
      }
    });

    expect(tui.getDimensions().cols).toBeGreaterThan(0);
    tui.start();
    tui.start(); // already running — early return branch
    tui.handleInput('a');
    expect(keyHit).toBe(true);
    tui.refresh(); // with rootComponent
    tui.stop();
    tui.stop(); // already stopped — early return branch

    // TUI without rootComponent — refresh early return
    const tuiEmpty = new TUI({});
    tuiEmpty.start();
    tuiEmpty.refresh(); // no rootComponent → early return
    tuiEmpty.stop();

    // TUI refresh when changedLines == 0 (no change) — covered by calling refresh twice
    tui.start();
    tui.refresh();
    tui.refresh();
    tui.stop();
  });
});
