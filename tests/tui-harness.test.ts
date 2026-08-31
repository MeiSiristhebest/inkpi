import { describe, it, expect } from 'vitest';
import { TerminalHarness } from '@inkpi/agent-core';

describe('@inkpi/agent-core -> TerminalHarness (TUI)', () => {
  it('should render split-screen ANSI interface and handle typing / Ghost Text Tab acceptance', async () => {
    const harness = new TerminalHarness({
      width: 80,
      height: 24,
      labels: {
        resources: 'Resources',
        editor: 'Editor',
        console: 'Console',
        ghostSuggestion: 'Suggestion',
        acceptSuggestion: 'Tab to accept',
        inserted: 'Inserted',
        accepted: 'Suggestion accepted',
        ready: 'Ready',
        resourceMetric: (count) => `${count} chars`
      }
    });

    // 1. Initial screen render
    const frame1 = harness.renderScreen();
    expect(frame1).toContain('Resources');
    expect(frame1).toContain('Editor - Untitled resource');
    expect(frame1).toContain('Console');

    // 2. Type text into editor
    await harness.handleInput('夜色渐浓，月光如水。');
    expect(harness.editor.getText()).toContain('夜色渐浓，月光如水。');

    // 3. Set Ghost text and verify rendering
    harness.ghost.setGhostText(harness.editor.getText().length, 'Dragons roared in the distant mountains.');
    const frameWithGhost = harness.renderScreen();
    expect(frameWithGhost).toContain('Suggestion');
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
