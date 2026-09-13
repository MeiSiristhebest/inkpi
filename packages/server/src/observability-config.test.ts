import { describe, expect, it } from 'vitest';
import { readObservabilitySampleRate } from './observability-config.js';

describe('daemon observability configuration', () => {
  it('leaves sampling unset unless deployment opts in', () => {
    expect(readObservabilitySampleRate({})).toBeUndefined();
  });

  it.each(['0', '0.25', '1'])('accepts a bounded sample rate (%s)', (value) => {
    expect(readObservabilitySampleRate({ INKPI_OBSERVABILITY_SAMPLE_RATE: value })).toBe(Number(value));
  });

  it.each(['-0.1', '1.1', 'not-a-number'])('rejects an invalid sample rate (%s)', (value) => {
    expect(() => readObservabilitySampleRate({ INKPI_OBSERVABILITY_SAMPLE_RATE: value })).toThrow(/between 0 and 1/);
  });

  it('trims a configured rate', () => {
    expect(readObservabilitySampleRate({ INKPI_OBSERVABILITY_SAMPLE_RATE: ' 0.5 ' })).toBe(0.5);
  });
});
