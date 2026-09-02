import { describe, expect, it } from 'vitest';
import {
  // 权威名称
  TerminalStudio,
  TerminalHarness,
  // 弃用别名
  TuiStudio,
  TerminalWriterHarness
} from '@inkpi/tui';

/**
 * @inkpi/tui 集中弃用别名（src/deprecations.ts）的兼容性守卫。
 * 保证别名仍指向唯一权威实现；v1.0 移除别名时删除本测试的对应断言即可。
 */
describe('tui deprecations: 集中别名与权威名称同址', () => {
  it('TuiStudio === TerminalStudio', () => {
    expect(TuiStudio).toBe(TerminalStudio);
  });

  it('TerminalWriterHarness === TerminalHarness', () => {
    expect(TerminalWriterHarness).toBe(TerminalHarness);
  });
});
