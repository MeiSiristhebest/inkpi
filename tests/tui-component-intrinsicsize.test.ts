import { Box, Spacer, VStack } from '@inkpi/tui';
import { describe, expect, it } from 'vitest';

/**
 * Guards the C6 refactor: layout engines discriminate spacers via the
 * `intrinsicSize()` contract instead of `instanceof SpacerComponent`.
 */
describe('@inkpi/tui component intrinsicSize contract', () => {
  it('SpacerComponent reports its size via intrinsicSize()', () => {
    expect(new Spacer(4).intrinsicSize()).toBe(4);
    expect(new Spacer(1).intrinsicSize()).toBe(1);
  });

  it('non-spacer components default to intrinsicSize() === 0 (flexible)', () => {
    expect(new Box({}).intrinsicSize()).toBe(0);
  });

  it('VStack treats spacers as fixed-size and other children as flexible', () => {
    const width = 40;
    const height = 10;
    const stack = new VStack();
    stack.add(new Box({ title: 'A' })); // flexible
    stack.add(new Spacer(3)); // fixed 3 rows
    stack.add(new Box({ title: 'B' })); // flexible

    const lines = stack.render({ width, height });
    expect(lines.length).toBe(height);

    // The spacer occupies exactly its 3 middle rows as blank lines.
    for (let row = 3; row < 6; row += 1) {
      expect(lines[row]).toBe(' '.repeat(width));
    }
    // Adjacent rows belong to the flexible boxes (bordered, not blank).
    expect(lines[0]).not.toBe(' '.repeat(width));
    expect(lines[6]).not.toBe(' '.repeat(width));
  });
});
