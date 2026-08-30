import { describe, it, expect } from 'vitest';
import { TerminalWriterHarness } from '@inkpi/agent-core';

describe('@inkpi/agent-core -> TerminalWriterHarness (TUI)', () => {
  it('should render split-screen ANSI interface and handle typing / Ghost Text Tab acceptance', async () => {
    const harness = new TerminalWriterHarness({
      width: 80,
      height: 24
    });

    // 1. Initial screen render
    const frame1 = harness.renderScreen();
    expect(frame1).toContain('资源列表');
    expect(frame1).toContain('编辑 - 新建文档');
    expect(frame1).toContain('AI 副驾驶 & 控制台');

    // 2. Type text into editor
    await harness.handleInput('夜色渐浓，月光如水。');
    expect(harness.editor.getText()).toContain('夜色渐浓，月光如水。');

    // 3. Set Ghost text and verify rendering
    harness.ghost.setGhostText(harness.editor.getText().length, 'Dragons roared in the distant mountains.');
    const frameWithGhost = harness.renderScreen();
    expect(frameWithGhost).toContain('[建议]');
    expect(frameWithGhost).toContain('Dragons roared in the distant mountains');

    // 4. Tab key input should accept ghost text
    const acceptRes = await harness.handleInput('TAB');
    expect(acceptRes).toBe('Ghost text accepted');
    expect(harness.editor.getText()).toContain('Dragons roared in the distant mountains');
    expect(harness.ghost.hasGhostText()).toBe(false);

    const noGhostRes = await harness.handleInput('\t');
    expect(noGhostRes).toBe('No active ghost text');

    // 5. Slash command execution inside TUI
    const cmdRes = await harness.handleInput('/help');
    expect(cmdRes).toContain('InkPi 指令清单');

    harness.log('测试日志输出');
    expect(harness.renderScreen()).toContain('测试日志输出');
  });
});

