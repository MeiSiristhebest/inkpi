import { Agent } from '@inkpi/agent-core';
import { getModelPreset } from '@inkpi/ai';
import { TerminalStudio } from '@inkpi/tui';
import { describe, expect, it, vi } from 'vitest';

describe('TerminalStudio (Terminal Workstation)', () => {
  it('should initialize with default 3-pane layout and render full screen', () => {
    const studio = new TerminalStudio({ width: 120, height: 30 });
    const screen = studio.renderScreen();

    expect(screen).toContain('Resources');
    expect(screen).toContain('Editor');
    expect(screen).toContain('Runtime State');
  });

  it('should support differential screen rendering', () => {
    const studio = new TerminalStudio({ width: 100, height: 26 });

    // First render -> full content
    const firstDiff = studio.renderDifferential();
    expect(firstDiff.content.length).toBeGreaterThan(0);

    // Immediate second render without mutations -> empty diff
    const secondDiff = studio.renderDifferential();
    expect(secondDiff.isDiff).toBe(false);
    expect(secondDiff.content).toBe('');

    // Mutate state -> differential update detected
    studio.editor.insert('Updated text inside editor buffer');
    const thirdDiff = studio.renderDifferential();
    expect(thirdDiff.isDiff).toBe(true);
    expect(thirdDiff.content).toContain('Updated text');
    expect(thirdDiff.content).toContain('\x1b[2K');
    expect(thirdDiff.content.length).toBeLessThan(studio.renderScreen().length);
  });

  it('should wrap long CJK documents to the visible editor rows', () => {
    const studio = new TerminalStudio({ width: 100, height: 26 });
    studio.editor.insert(
      `开篇标记${'林玄在青云山下停住脚步，远处云海翻涌，剑鸣从石阶尽头传来。'.repeat(3000)}\n末尾标记`
    );

    const frame = studio.renderScreen();
    expect(frame).toContain('末尾标记');
    expect(Buffer.byteLength(frame)).toBeLessThan(20_000);

    studio.renderDifferential();
    studio.editor.insert('新增结尾。');
    const diff = studio.renderDifferential();
    expect(diff.isDiff).toBe(true);
    expect(Buffer.byteLength(diff.content)).toBeLessThan(Buffer.byteLength(studio.renderScreen()));

    studio.setDimensions(140, 35);
    const resizeDiff = studio.renderDifferential();
    expect(resizeDiff.isDiff).toBe(true);

    studio.setFocus('outline');
    const focusDiff = studio.renderDifferential();
    expect(focusDiff.isDiff).toBe(true);
    expect(focusDiff.content).toContain('\x1b[33m');
  });

  it('should reuse wrapped editor content until text or viewport dimensions change', () => {
    const studio = new TerminalStudio({ width: 120, height: 30 });
    const getText = vi.spyOn(studio.editor, 'getText');
    studio.editor.insert('林玄在青云山下停住脚步。'.repeat(500));
    getText.mockClear();

    studio.renderScreen();
    expect(getText).toHaveBeenCalledTimes(2);

    getText.mockClear();
    studio.renderScreen();
    studio.setFocus('outline');
    studio.renderScreen();
    expect(getText).not.toHaveBeenCalled();

    studio.setDimensions(140, 35);
    studio.renderScreen();
    expect(getText).toHaveBeenCalledTimes(1);

    studio.editor.insert('新增内容。');
    getText.mockClear();
    studio.renderScreen();
    expect(getText).toHaveBeenCalledTimes(2);
  });

  it('should support document navigation and focus switching', () => {
    const studio = new TerminalStudio({
      initialResources: [
        {
          id: '1',
          title: 'Doc 1',
          wordCount: 0,
          status: 'draft',
          active: true
        },
        {
          id: '2',
          title: 'Doc 2',
          wordCount: 0,
          status: 'draft',
          active: false
        }
      ]
    });

    expect(studio.activeResourceIndex).toBe(0);
    const switchedNext = studio.nextResource();
    expect(switchedNext).toBe(true);
    expect(studio.activeResourceIndex).toBe(1);

    const switchedPrev = studio.prevResource();
    expect(switchedPrev).toBe(true);
    expect(studio.activeResourceIndex).toBe(0);

    studio.setFocus('outline');
    expect(studio.focusMode).toBe('outline');
    studio.setFocus('copilot');
    expect(studio.focusMode).toBe('copilot');
  });

  it('should handle interactive input, ghost text acceptance, and commands', async () => {
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') }
    });
    const studio = new TerminalStudio({ agent });

    // 1. Text input
    const inputRes = await studio.handleInput('Cool night, wind over the roof.');
    expect(inputRes).toBe('Text inserted');
    expect(studio.editor.getText()).toContain('Cool night');

    // 2. Ghost text set & accept
    studio.ghost.setGhostText(studio.editor.getText().length, 'Sword vibrated.');
    expect(studio.ghost.hasGhostText()).toBe(true);

    const tabRes = await studio.handleInput('\t');
    expect(tabRes).toBe('Ghost text accepted');
    expect(studio.editor.getText()).toContain('Sword vibrated.');

    // 3. Focus command
    const focusRes = await studio.handleInput(':focus editor');
    expect(focusRes).toBe('Focused on editor');
    expect(studio.focusMode).toBe('editor');

    // 4. Slash command
    const helpRes = await studio.handleInput('/help');
    expect(helpRes).toContain('指令清单');
  });

  it('should handle dimensions, document navigation boundaries, and agent event streaming', async () => {
    const agent = new Agent({
      initialState: { model: getModelPreset('mock-test') }
    });
    const studio = new TerminalStudio({ agent, width: 100, height: 28 });

    studio.setDimensions(140, 35);
    const dims = studio.getDimensions();
    expect(dims.width).toBe(140);
    expect(dims.height).toBe(35);

    // Boundary for prevResource at 0
    expect(studio.activeResourceIndex).toBe(0);
    const prevAtZero = studio.prevResource();
    expect(prevAtZero).toBe(false);

    // Navigate to end
    while (studio.nextResource()) {}
    expect(studio.activeResourceIndex).toBe(studio.resources.length - 1);
    const nextAtEnd = studio.nextResource();
    expect(nextAtEnd).toBe(false);

    // Focus copilot, outline, editor, ledger via input
    await studio.handleInput(':focus copilot');
    expect(studio.focusMode).toBe('copilot');
    await studio.handleInput(':focus outline');
    expect(studio.focusMode).toBe('outline');
    await studio.handleInput(':focus editor');
    expect(studio.focusMode).toBe('editor');
    await studio.handleInput(':focus ledger');
    expect(studio.focusMode).toBe('ledger');

    // Tab without ghost text
    const noGhostRes = await studio.handleInput('TAB');
    expect(noGhostRes).toBe('No active ghost text');

    // Render screen with empty ledger and dialogue
    const emptyStudio = new TerminalStudio({ width: 90, height: 26 });
    const emptyScreen = emptyStudio.renderScreen();
    expect(emptyScreen).toContain('no entities');
    expect(emptyScreen).toContain('no assets');
    expect(emptyScreen).toContain('no tracks');
    // Render screen with fully populated ledger
    const populatedStudio = new TerminalStudio({ width: 100, height: 28 });
    populatedStudio.updateStateLedger({
      entities: [{ name: 'UserD', status: 'Level 50' }],
      assets: [{ name: 'Epic Asset' }],
      tracks: [{ clue: 'Ancient Site' }],
      locations: [{ name: 'Guild A' }],
      modifiedDocuments: ['ch_1']
    });
    const populatedScreen = populatedStudio.renderScreen();
    expect(populatedScreen).toContain('UserD');
    expect(populatedScreen).toContain('Epic Asset');
    expect(populatedScreen).toContain('Ancient Site');

    // Trigger agent prompt to test dialogue streaming listener
    await agent.prompt('Hello, write a battle scene');
    const screen = studio.renderScreen();
    expect(screen).toBeDefined();
  });

  it('should handle modal input commands UP, ENTER, ESC and custom labels', async () => {
    const studio = new TerminalStudio({
      labels: {
        leftBoxTitle: 'Custom Explorer',
        statusReady: 'Custom Ready'
      }
    });
    expect(studio.renderScreen()).toContain('Custom Explorer');

    // Open select list modal
    studio.openSelectList({
      title: 'Choose Template',
      items: [
        { id: '1', label: 'Item A', value: 'a' },
        { id: '2', label: 'Item B', value: 'b' }
      ]
    });

    // Test UP, DOWN, ENTER in modal
    const downRes = await studio.handleInput('DOWN');
    expect(downRes).toBe('Selection down');
    const upRes = await studio.handleInput('UP');
    expect(upRes).toBe('Selection up');

    const enterRes = await studio.handleInput('ENTER');
    expect(enterRes).toContain('Selected:');
    expect(studio.activeModal).toBeNull();

    // Open and cancel via ESC
    studio.openSelectList({
      title: 'Choose Another',
      items: [{ id: '1', label: 'Item 1', value: '1' }]
    });
    const escRes = await studio.handleInput('ESC');
    expect(escRes).toBe('Modal closed');
    expect(studio.activeModal).toBeNull();
  });
});
