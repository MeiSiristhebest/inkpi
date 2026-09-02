import { describe, it, expect } from 'vitest';
import { escapeHtml } from '../packages/agent-core/src/export/html.js';
import { installTestDoubles } from '../packages/ai/src/test-fixtures.js';

// ---------------------------------------------------------------------------
// escapeHtml 是各导出器（session-export / session-report-export / session-share）
// 共用的单一实现。评审指出过三份各自为政的实现中有一份不转义单引号，
// 在单引号属性上下文中存在 XSS 面。这里的用例锁死统一后的行为。
// ---------------------------------------------------------------------------
describe('escapeHtml (shared single implementation)', () => {
  it('空值归一为空串', () => {
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml('')).toBe('');
  });

  it('转义全部六个危险字符', () => {
    expect(escapeHtml(`&<>"'/`)).toBe('&amp;&lt;&gt;&quot;&#039;&#047;');
  });

  it('阻断单引号属性上下文中的注入', () => {
    const payload = `x' onmouseover='alert(1)`;
    const out = escapeHtml(payload);
    expect(out).not.toContain(`'`);
    expect(out).toContain('&#039;');
  });

  it('阻断含斜杠的闭合标签与协议向量', () => {
    const payload = `</script><img src=x onerror=alert(1)>`;
    const out = escapeHtml(payload);
    expect(out).toContain('&#047;');
    expect(out).not.toContain('<');
    expect(out).not.toContain('>');
    expect(out).not.toContain(`'`);
  });

  it('非字符串入参先转字符串再转义', () => {
    expect(escapeHtml(42)).toBe('42');
    expect(escapeHtml(0)).toBe('0');
    expect(escapeHtml(false)).toBe('false');
    expect(escapeHtml('<b>')).toBe('&lt;b&gt;');
  });

  it('已转义内容不会被二次转义破坏语义（幂等性仅对无特殊字符输入成立）', () => {
    // 说明：本函数不做幂等去重，重复转义是调用方责任；此处固定当前语义，
    // 防止后续有人"优化"成去重实现而破坏既有导出快照。
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
});

// ---------------------------------------------------------------------------
// installTestDoubles 的幂等分支：既要在未安装时完成注册，
// 也要保证重复调用不抛错、不重复注册。
// ---------------------------------------------------------------------------
describe('installTestDoubles idempotency', () => {
  it('重复调用安全，且不改变已注册的预设', async () => {
    const ai = await import('@inkpi/ai');
    installTestDoubles();
    const before = ai.getModelPreset('mock-test');

    expect(() => installTestDoubles()).not.toThrow();
    expect(() => installTestDoubles()).not.toThrow();

    const after = ai.getModelPreset('mock-test');
    expect(after).toEqual(before);
    expect(after.provider).toBe('faux');
  });
});
