import { describe, expect, it } from 'vitest';
import {
  Component,
  type OverlayAnchor,
  OverlayManager,
  type RenderContext,
  TUI,
  isFocusable
} from '../packages/tui/src/index.js';

class SimpleBox extends Component {
  constructor(public focused = false) {
    super();
  }
  public render(context: RenderContext): string[] {
    return [`[Box ${context.width}x${context.height}]`];
  }
  public handleKey(key: any): boolean {
    return key.name === 'enter';
  }
}

describe('TUI Overlay Anchors & Focusable Comprehensive Coverage', () => {
  it('should test isFocusable type guard', () => {
    expect(isFocusable(null)).toBe(false);
    expect(isFocusable('string')).toBe(false);
    expect(isFocusable({})).toBe(false);
    expect(isFocusable(new SimpleBox(true))).toBe(true);
  });

  it('should cover all 9 anchor positions in OverlayManager', () => {
    const anchors: OverlayAnchor[] = [
      'center',
      'top-left',
      'top-center',
      'top-right',
      'bottom-left',
      'bottom-center',
      'bottom-right',
      'left-center',
      'right-center'
    ];

    const baseLines = [
      'Line 1: 01234567890123456789',
      'Line 2: 01234567890123456789',
      'Line 3: 01234567890123456789',
      'Line 4: 01234567890123456789',
      'Line 5: 01234567890123456789'
    ];

    for (const anchor of anchors) {
      const mgr = new OverlayManager();
      const handle = mgr.show(new SimpleBox(), {
        anchor,
        width: 10,
        height: 2,
        margin: { top: 1, bottom: 1, left: 1, right: 1 }
      });
      expect(mgr.hasOverlays()).toBe(true);
      const composited = mgr.composite(baseLines, 30, 5);
      expect(composited).toHaveLength(5);
      mgr.hide(handle.id);
      expect(mgr.hasOverlays()).toBe(false);
    }
  });

  it('should test TUI showOverlay, hideOverlay and modal input routing', () => {
    const tui = new TUI();
    const box = new SimpleBox();

    const handle = tui.showOverlay(box, { modal: true });
    expect(tui.overlayManager.hasOverlays()).toBe(true);

    // Test input routing to modal overlay
    tui.handleInput(Buffer.from('\r')); // enter

    // Test escape key to dismiss overlay
    tui.handleInput(Buffer.from('\x1b')); // escape
    expect(tui.overlayManager.hasOverlays()).toBe(false);

    // Test hiding invalid overlay returns false
    expect(tui.hideOverlay('non_existent')).toBe(false);
  });
});
