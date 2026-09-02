import { describe, it, expect } from 'vitest';
import { detectGateIssues } from '../packages/agent-core/src/pipeline/gate-detection.js';
import type { QualityGateRule, StateLedger } from '@inkpi/protocol';

describe('detectGateIssues (pure)', () => {
  it('字符串 pattern 命中则上报对应 issue', () => {
    const rules: QualityGateRule[] = [
      { type: 'toxicity', description: '禁止脏话', severity: 'critical', pattern: 'badword' }
    ];
    const issues = detectGateIssues('this is a badword example', rules);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ type: 'toxicity', description: '禁止脏话', severity: 'critical' });
  });

  it('字符串 pattern 未命中返回空', () => {
    const rules: QualityGateRule[] = [
      { type: 'toxicity', description: 'd', severity: 'critical', pattern: 'badword' }
    ];
    expect(detectGateIssues('clean text', rules)).toHaveLength(0);
  });

  it('全局正则每次检测前重置 lastIndex，避免状态串扰', () => {
    const rules: QualityGateRule[] = [
      { type: 'p', description: 'd', severity: 'info', pattern: /x/g }
    ];
    // 第一次调用后应重置，第二次仍能命中
    expect(detectGateIssues('x', rules)).toHaveLength(1);
    expect(detectGateIssues('x', rules)).toHaveLength(1);
    expect(detectGateIssues('y', rules)).toHaveLength(0);
  });

  it('detector 返回 issue 则上报', () => {
    const rules: QualityGateRule[] = [
      { type: 'custom', description: 'detected', severity: 'warning', detector: () => ({ type: 'custom', description: 'detected', severity: 'warning' }) }
    ];
    const issues = detectGateIssues('anything', rules);
    expect(issues).toHaveLength(1);
  });

  it('detector 返回 falsy 不上报', () => {
    const rules: QualityGateRule[] = [
      { type: 'custom', description: 'd', severity: 'info', detector: () => null }
    ];
    expect(detectGateIssues('anything', rules)).toHaveLength(0);
  });

  it('ledger 缺省时回退空账本，detector 收到空账本', () => {
    let received: StateLedger | undefined;
    const rules: QualityGateRule[] = [
      { type: 'c', description: 'd', severity: 'info', detector: (_c, ledger) => { received = ledger; return null; } }
    ];
    detectGateIssues('x', rules);
    expect(received).toBeDefined();
    expect((received as StateLedger).entities).toEqual([]);
  });

  it('传入的 ledger 透传给 detector', () => {
    const ledger: StateLedger = { entities: [{ id: 'e1', name: 'A' }], assets: [], tracks: [], locations: [], modifiedResources: [] };
    let received: StateLedger | undefined;
    const rules: QualityGateRule[] = [
      { type: 'c', description: 'd', severity: 'info', detector: (_c, l) => { received = l; return null; } }
    ];
    detectGateIssues('x', rules, ledger);
    expect(received?.entities[0]?.name).toBe('A');
  });
});
