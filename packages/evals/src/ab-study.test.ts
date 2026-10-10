import { describe, expect, it } from 'vitest';
import { type ABStudyObservation, type ABStudyPlan, createABStudyPlan, evaluateABStudy } from './ab-study.js';

const sha = (character: string): string => character.repeat(64);

function makePlan(): ABStudyPlan {
  return createABStudyPlan({
    id: 'cache-policy-study',
    createdAt: 100,
    artifactSha256: sha('a'),
    corpusSha256: sha('b'),
    environmentSha256: sha('c'),
    evaluationPlanSha256: sha('f'),
    control: { id: 'cache-off', configSha256: sha('d') },
    candidate: { id: 'cache-on', configSha256: sha('e') },
    caseIds: ['chapter-short', 'chapter-long'],
    repetitions: 2
  });
}

function completeObservations(plan: ABStudyPlan): ABStudyObservation[] {
  return plan.slots.flatMap((slot, slotIndex) =>
    slot.order.map((variantId, orderIndex) => ({
      planId: plan.id,
      planSha256: plan.planSha256,
      caseId: slot.caseId,
      repetition: slot.repetition,
      variantId,
      runSequence: slotIndex * 2 + orderIndex,
      orderIndex: orderIndex as 0 | 1,
      artifactSha256: plan.artifactSha256,
      corpusSha256: plan.corpusSha256,
      environmentSha256: plan.environmentSha256,
      evaluationPlanSha256: plan.evaluationPlanSha256,
      variantConfigSha256: variantId === plan.control.id ? plan.control.configSha256 : plan.candidate.configSha256,
      startedAt: 101 + slotIndex * 2 + orderIndex,
      qualityScore: variantId === plan.candidate.id ? 90 : 80,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: variantId === plan.candidate.id ? 40 : 0,
      cacheWriteTokens: variantId === plan.candidate.id ? 50 : 0,
      durationMs: variantId === plan.candidate.id ? 800 : 1000,
      costUsd: variantId === plan.candidate.id ? 0.02 : 0.03
    }))
  );
}

describe('paired A/B study evidence', () => {
  it('creates a plan before runs and balances variant order across cases and repetitions', () => {
    const plan = makePlan();
    expect(plan.slots.map((slot) => slot.order)).toEqual([
      ['cache-off', 'cache-on'],
      ['cache-on', 'cache-off'],
      ['cache-on', 'cache-off'],
      ['cache-off', 'cache-on']
    ]);
    expect(Object.isFrozen(plan.slots)).toBe(true);
  });

  it('compares quality, token use, cache use, latency, and cost for complete paired runs', () => {
    const plan = makePlan();
    const report = evaluateABStudy(plan, completeObservations(plan));

    expect(report).toMatchObject({
      status: 'complete',
      expectedObservationCount: 8,
      observedObservationCount: 8,
      pairedRunCount: 4,
      quality: { status: 'complete', control: 80, candidate: 90, candidateMinusControl: 10 },
      inputTokens: { status: 'complete', control: 400, candidate: 400 },
      cacheReadTokens: { status: 'complete', control: 0, candidate: 160 },
      cacheWriteTokens: { status: 'complete', control: 0, candidate: 200 },
      durationMs: { status: 'complete', control: 1000, candidate: 800, candidateMinusControl: -200 },
      costUsd: { status: 'complete', control: 0.12, candidate: 0.08 }
    });
  });

  it('binds observations to the full plan content across serialization', () => {
    const plan = makePlan();
    const observations = completeObservations(plan);
    const restoredPlan = JSON.parse(JSON.stringify(plan)) as ABStudyPlan;

    expect(evaluateABStudy(restoredPlan, observations)).toMatchObject({
      status: 'complete',
      planSha256: plan.planSha256
    });

    const changedPlan = { ...plan, caseIds: [...plan.caseIds, 'new-case'] } as ABStudyPlan;
    expect(evaluateABStudy(changedPlan, observations)).toMatchObject({ status: 'invalid' });
    expect(
      evaluateABStudy(
        plan,
        observations.map((run) => ({ ...run, planSha256: sha('f') }))
      )
    ).toMatchObject({ status: 'invalid' });
  });

  it('marks absent quality scores unavailable instead of summarizing a partial study', () => {
    const plan = makePlan();
    const observations = completeObservations(plan);
    observations[0]!.qualityScore = undefined;

    const report = evaluateABStudy(plan, observations);

    expect(report.status).toBe('unavailable');
    expect(report.quality).toMatchObject({ status: 'unavailable', reason: 'Missing qualityScore measurement.' });
    expect(report.costUsd).toMatchObject({ status: 'complete' });
  });

  it('marks missing cost or latency as unavailable without treating it as zero', () => {
    const plan = makePlan();
    const observations = completeObservations(plan);
    observations[3]!.costUsd = undefined;
    observations[5]!.durationMs = undefined;

    const report = evaluateABStudy(plan, observations);

    expect(report.status).toBe('complete');
    expect(report.costUsd).toMatchObject({ status: 'unavailable', reason: 'Missing costUsd measurement.' });
    expect(report.durationMs).toMatchObject({ status: 'unavailable', reason: 'Missing durationMs measurement.' });
  });

  it('refuses incomplete, duplicate, out-of-order, or identity-mismatched evidence', () => {
    const plan = makePlan();
    const observations = completeObservations(plan);

    expect(evaluateABStudy(plan, observations.slice(1)).status).toBe('unavailable');
    expect(evaluateABStudy(plan, [...observations, observations[0]!])).toMatchObject({
      status: 'invalid',
      quality: { status: 'unavailable' }
    });
    expect(
      evaluateABStudy(
        plan,
        observations.map((run, index) => (index === 0 ? { ...run, orderIndex: 1 } : run))
      )
    ).toMatchObject({ status: 'invalid' });
    expect(
      evaluateABStudy(
        plan,
        observations.map((run, index) => (index === 0 ? { ...run, artifactSha256: sha('f') } : run))
      )
    ).toMatchObject({ status: 'invalid' });
    expect(
      evaluateABStudy(
        plan,
        observations.map((run, index) => (index === 0 ? { ...run, variantConfigSha256: sha('f') } : run))
      )
    ).toMatchObject({ status: 'invalid' });
  });

  it('rejects run records that contradict the planned sequence or start-time order', () => {
    const plan = makePlan();
    const observations = completeObservations(plan);
    const wrongSequence = observations.map((run, index) => (index === 0 ? { ...run, runSequence: 1 } : run));
    expect(evaluateABStudy(plan, wrongSequence)).toMatchObject({ status: 'invalid' });

    const reversedStartTimes = observations.map((run, index) => {
      if (index === 0) return { ...run, startedAt: observations[1]!.startedAt };
      if (index === 1) return { ...run, startedAt: observations[0]!.startedAt };
      return run;
    });
    expect(evaluateABStudy(plan, reversedStartTimes)).toMatchObject({ status: 'invalid' });
  });

  it('rejects invalid plans before an experiment can start', () => {
    expect(() =>
      createABStudyPlan({
        ...makePlan(),
        id: 'invalid',
        caseIds: ['duplicate', 'duplicate']
      })
    ).toThrow('A/B study case IDs must be unique.');
    expect(() =>
      createABStudyPlan({
        ...makePlan(),
        id: 'same-variant',
        control: { id: 'same', configSha256: sha('a') },
        candidate: { id: 'same', configSha256: sha('b') }
      })
    ).toThrow('Control and candidate variant IDs must differ.');
  });
});
