import { describe, expect, it } from 'vitest';
import {
  REAL_PROVIDER_ACCEPTANCE_MARKER,
  evaluateRealProviderResult,
  readRealProviderAcceptancePlan,
  reportSkippedOrInvalid
} from './real-provider-acceptance.js';

describe('real provider acceptance gate', () => {
  it('does not run or pass without the explicit environment gate', () => {
    const plan = readRealProviderAcceptancePlan({
      INKPI_ACCEPTANCE_PROVIDER: 'openai',
      INKPI_ACCEPTANCE_MODEL: 'gpt-test',
      OPENAI_API_KEY: 'secret'
    });

    expect(plan).toEqual({
      status: 'skipped',
      reason: 'Set INKPI_RUN_REAL_PROVIDER_ACCEPTANCE=1 to invoke a real provider.'
    });
    if (plan.status !== 'skipped') throw new Error('Expected the real-provider acceptance to be skipped.');
    expect(reportSkippedOrInvalid(plan).passed).toBe(false);
  });

  it('requires an explicit supported provider, model, and credential', () => {
    expect(readRealProviderAcceptancePlan({ INKPI_RUN_REAL_PROVIDER_ACCEPTANCE: '1' })).toMatchObject({
      status: 'invalid',
      reason: expect.stringContaining('INKPI_ACCEPTANCE_PROVIDER')
    });
    expect(
      readRealProviderAcceptancePlan({
        INKPI_RUN_REAL_PROVIDER_ACCEPTANCE: '1',
        INKPI_ACCEPTANCE_PROVIDER: 'openai'
      })
    ).toMatchObject({ status: 'invalid', reason: expect.stringContaining('INKPI_ACCEPTANCE_MODEL') });
    expect(
      readRealProviderAcceptancePlan({
        INKPI_RUN_REAL_PROVIDER_ACCEPTANCE: '1',
        INKPI_ACCEPTANCE_PROVIDER: 'openai',
        INKPI_ACCEPTANCE_MODEL: 'gpt-test'
      })
    ).toMatchObject({ status: 'invalid', reason: expect.stringContaining('OPENAI_API_KEY') });
    const invalid = readRealProviderAcceptancePlan({
      INKPI_RUN_REAL_PROVIDER_ACCEPTANCE: '1',
      INKPI_ACCEPTANCE_PROVIDER: 'openai',
      INKPI_ACCEPTANCE_MODEL: 'gpt-test'
    });
    if (invalid.status !== 'invalid') throw new Error('Expected invalid real-provider configuration.');
    expect(reportSkippedOrInvalid(invalid)).toMatchObject({ status: 'failed', passed: false });
  });

  it('builds a ready plan without exposing the credential in acceptance reports', () => {
    const plan = readRealProviderAcceptancePlan({
      INKPI_RUN_REAL_PROVIDER_ACCEPTANCE: '1',
      INKPI_ACCEPTANCE_PROVIDER: 'anthropic',
      INKPI_ACCEPTANCE_MODEL: 'claude-test',
      ANTHROPIC_API_KEY: 'secret-key',
      INKPI_ACCEPTANCE_REPORT_FILE: 'acceptance.json'
    });

    expect(plan).toMatchObject({
      status: 'ready',
      config: {
        provider: 'anthropic',
        runtimeProvider: 'claude',
        model: 'claude-test',
        reportFile: 'acceptance.json',
        expectedMarker: REAL_PROVIDER_ACCEPTANCE_MARKER
      }
    });
    expect(
      JSON.stringify(
        evaluateRealProviderResult(plan.status === 'ready' ? plan.config : undefined!, {
          success: true,
          content: REAL_PROVIDER_ACCEPTANCE_MARKER,
          durationMs: 12
        })
      )
    ).not.toContain('secret-key');
  });

  it('fails a provider run that is empty or missing the marker', () => {
    const config = { provider: 'openai' as const, model: 'gpt-test', expectedMarker: REAL_PROVIDER_ACCEPTANCE_MARKER };
    expect(evaluateRealProviderResult(config, { success: true, content: 'unrelated', durationMs: 3 })).toMatchObject({
      status: 'failed',
      passed: false,
      responseContainsMarker: false
    });
    expect(
      evaluateRealProviderResult(config, { success: false, content: '', durationMs: 4, error: 'provider failed' })
    ).toMatchObject({ status: 'failed', passed: false, reason: 'provider failed' });
  });

  it('passes only a successful non-empty response containing the marker', () => {
    expect(
      evaluateRealProviderResult(
        { provider: 'deepseek', model: 'deepseek-test', expectedMarker: REAL_PROVIDER_ACCEPTANCE_MARKER },
        { success: true, content: ` ${REAL_PROVIDER_ACCEPTANCE_MARKER} `, durationMs: 8 }
      )
    ).toMatchObject({ status: 'passed', passed: true, contentLength: REAL_PROVIDER_ACCEPTANCE_MARKER.length });
  });
});
