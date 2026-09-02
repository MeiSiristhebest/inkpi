import { describe, it, expect } from 'vitest';
import {
  NoModelConfiguredError,
  InvalidDiceNotationError,
  LiveSessionManager,
  SandboxManager
} from '@inkpi/agent-core';

// ---------------------------------------------------------------------------
// 领域错误类型是公开契约的一部分：消费方必须能按类型捕获，而不是靠字符串匹配
// 错误消息。这两个类取代了原先的两处静默降级：
//   - 无模型时静默回落到返回固定字符串的假模型
//   - 骰子记号非法时静默返回伪造的 1d20 随机数
// ---------------------------------------------------------------------------
describe('NoModelConfiguredError', () => {
  it('无参构造时给出可操作的默认消息', () => {
    const err = new NoModelConfiguredError();
    expect(err.name).toBe('NoModelConfiguredError');
    expect(err).toBeInstanceOf(Error);
    // 默认消息必须说明"怎么办"，而不只是"错了"
    expect(err.message).toMatch(/explicit model|default model|provider/i);
  });

  it('接受自定义消息', () => {
    const err = new NoModelConfiguredError('custom: no model');
    expect(err.message).toBe('custom: no model');
  });

  it('由 LiveSessionManager 在无模型时抛出，且可按类型捕获', () => {
    const sm = new LiveSessionManager();
    expect(() => sm.createSession({ sessionId: 'err-session' })).toThrow(NoModelConfiguredError);
    try {
      sm.createSession({ sessionId: 'err-session-2' });
      expect.unreachable('应已抛出');
    } catch (e) {
      expect(e).toBeInstanceOf(NoModelConfiguredError);
    }
  });
});

describe('InvalidDiceNotationError', () => {
  it('无自定义消息时回显非法记号', () => {
    const err = new InvalidDiceNotationError('abc');
    expect(err.name).toBe('InvalidDiceNotationError');
    expect(err.message).toContain('abc');
    expect(err.message).toMatch(/1d20/);
  });

  it('接受自定义消息', () => {
    const err = new InvalidDiceNotationError('abc', 'custom: bad dice');
    expect(err.message).toBe('custom: bad dice');
  });

  // 说明：`roll` 是注入到沙箱脚本内的全局函数，不是 SandboxManager 的方法；
  // 脚本内抛出的错误由 runRuleScript 捕获为 success:false，而不是向外 reject。
  it('沙箱对非法记号判定失败，而不是返回伪造随机数', async () => {
    const sandbox = new SandboxManager();
    const bad = await sandbox.runRuleScript<number>(`return roll('not-a-dice-expression');`);
    expect(bad.success).toBe(false);
    expect(String(bad.error ?? '')).toMatch(/Invalid dice notation/i);
    // 关键：绝不能静默返回一个 1..20 之间的伪造值
    expect(bad.result).toBeUndefined();
  });

  it('沙箱对合法记号正常返回区间内的值', async () => {
    const sandbox = new SandboxManager();
    const res = await sandbox.runRuleScript<number>(`return roll('1d6');`);
    expect(res.success).toBe(true);
    expect(res.result).toBeGreaterThanOrEqual(1);
    expect(res.result).toBeLessThanOrEqual(6);
  });
});
