import { describe, it, expect } from 'vitest';
import {
  TuiStudio,
  DifferentialRenderer,
  layoutHStack,
  layoutVStack,
  renderScrollView
} from '@inkpi/agent-core';

describe('Pi TUI Engine Integration & Studio Layout', () => {
  it('should compute differential rendering updates correctly', () => {
    const renderer = new DifferentialRenderer();
    const frame1 = 'Line 1\nLine 2\nLine 3';
    const res1 = renderer.render(frame1);
    expect(res1.changedLines).toBe(3);
    expect(res1.output).toBe(frame1);

    // Frame 2 identical
    const res2 = renderer.render(frame1);
    expect(res2.changedLines).toBe(0);

    // Frame 3 single line changed
    const frame3 = 'Line 1\nLine 2 modified\nLine 3';
    const res3 = renderer.render(frame3);
    expect(res3.changedLines).toBe(1);
  });

  it('should support layout primitives (HStack, VStack, ScrollView)', () => {
    // VStack
    const vstack = layoutVStack([['Header'], ['Body 1', 'Body 2'], ['Footer']]);
    expect(vstack.length).toBe(4);
    expect(vstack[0]).toBe('Header');
    expect(vstack[3]).toBe('Footer');

    // HStack
    const hstack = layoutHStack([
      { lines: ['Left 1', 'Left 2'], width: 10 },
      { lines: ['Right 1', 'Right 2'], width: 10 }
    ], 2);
    expect(hstack.length).toBe(2);
    expect(hstack[0]).toContain('Left 1');
    expect(hstack[0]).toContain('Right 1');

    // ScrollView
    const longDoc = ['Line 1', 'Line 2', 'Line 3', 'Line 4', 'Line 5'];
    const scrolled = renderScrollView(longDoc, 3, 2);
    expect(scrolled.length).toBe(3);
    expect(scrolled[0]).toBe('Line 3');
    expect(scrolled[2]).toBe('Line 5');
  });

  it('should render TuiStudio with dual screen layout and handle select list modal', async () => {
    const studio = new TuiStudio({ width: 120, height: 30 });
    const screen = studio.renderScreen();
    expect(screen).toContain('资源目录树');
    expect(screen).toContain('编辑');
    expect(screen).toContain('状态账本');

    // Flash toast
    studio.flash('测试提示信息', 'success');
    const screenWithFlash = studio.renderScreen();
    expect(screenWithFlash).toContain('测试提示信息');

    // Open selectList modal
    studio.openSelectList({
      title: '请选择世界观模板',
      items: [
        { id: '1', label: 'Standard Genre', value: 'standard' },
        { id: '2', label: '赛博朋克流', value: 'cyberpunk' }
      ]
    });

    const modalScreen = studio.renderScreen();
    expect(modalScreen).toContain('请选择世界观模板');
    expect(modalScreen).toContain('Standard Genre');

    // Down navigation
    await studio.handleInput('DOWN');
    expect(studio.activeSelectIndex).toBe(1);

    // Confirm selection
    const confirmed = studio.confirmSelection();
    expect(confirmed).toBe('cyberpunk');
    expect(studio.activeModal).toBeNull();
  });

  it('should render entity ASCII avatar and manage scroll offsets', () => {
    const studio = new TuiStudio({ width: 120, height: 30 });
    studio.updateStateLedger({
      entities: [{ name: 'Alice', status: '指挥官' }],
      assets: [],
      tracks: [],
      locations: [],
      modifiedDocuments: []
    });

    const avatar = studio.renderEntityAvatar('Alice');
    expect(avatar.join('\n')).toContain('Alice');
    expect(avatar.join('\n')).toContain('指挥官');

    studio.scrollOutline(5);
    expect(studio.outlineScrollOffset).toBe(5);

    studio.scrollTranscript(10);
    expect(studio.transcriptScrollOffset).toBe(10);
  });
});
