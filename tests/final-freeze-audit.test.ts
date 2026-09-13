// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { FINAL_FREEZE_GROUPS, evaluateFreezeEvidence } from '../scripts/final-freeze-audit.mjs';

function completeEnvelope(): Record<string, unknown> {
  return {
    evidence: Object.fromEntries(
      FINAL_FREEZE_GROUPS.map(({ id }) => [
        id,
        { status: 'passed', source: `${id}-test-fixture`, recordedAt: '2026-09-12T00:00:00Z' }
      ])
    )
  };
}

describe('Phase 23 final freeze evidence gate', () => {
  it('does not pass with no external evidence envelope', () => {
    const report = evaluateFreezeEvidence({});
    expect(report).toMatchObject({
      eligible: false,
      status: 'pending',
      requiredGroupCount: 16,
      passedGroupCount: 0,
      localEvidenceGroupCount: 0,
      localPartialGroupCount: 0
    });
    expect(report.missing).toHaveLength(16);
  });

  it('passes only when every group has a dated source record', () => {
    const report = evaluateFreezeEvidence(completeEnvelope());
    expect(report).toMatchObject({ eligible: true, status: 'passed', passedGroupCount: 16 });
    expect(report.missing).toEqual([]);
    expect(report.failed).toEqual([]);
  });

  it('keeps failed, invalid, and waived-like statuses out of the freeze result', () => {
    const envelope = completeEnvelope() as {
      evidence: Record<string, { status: string; source: string; recordedAt?: string }>;
    };
    envelope.evidence.evals.status = 'failed';
    envelope.evidence.observability.status = 'waived';
    envelope.evidence.skills.recordedAt = undefined;
    const report = evaluateFreezeEvidence(envelope);
    expect(report.eligible).toBe(false);
    expect(report.failed).toEqual(['evals']);
    expect(report.missing).toContain('observability');
    expect(report.missing).toContain('skills');
  });

  it('reports local partial coverage without upgrading the formal freeze gate', () => {
    const localEvidence = Object.fromEntries(
      FINAL_FREEZE_GROUPS.map(({ id }) => [
        id,
        {
          status: 'partial',
          source: `tests/${id}.test.ts`,
          recordedAt: '2026-09-13T00:00:00Z'
        }
      ])
    );
    const report = evaluateFreezeEvidence({ localEvidence });
    expect(report).toMatchObject({
      eligible: false,
      passedGroupCount: 0,
      localEvidenceGroupCount: 16,
      localPartialGroupCount: 16
    });
    expect(report.localMissing).toEqual([]);
  });
});
