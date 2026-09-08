import type { AiTask, TaskResult } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { createLongContextBenchmark, evaluateTaskCase, runMutationChecks } from '@inkpi/evals';

describe('AI task evaluation contract', () => {
  it('scores status, output contract, provenance, and effect safety', () => {
    const task: AiTask = {
      id: 'eval-task',
      kind: 'creative.continue',
      input: {},
      outputContract: { format: 'text' },
      effectPolicy: { mode: 'proposal', requiresApproval: true },
    };
    const result: TaskResult = {
      taskId: task.id,
      kind: task.kind,
      status: 'completed',
      output: { format: 'text', text: '继续' },
      provenance: { contextFingerprint: 'abc' },
    };
    const report = evaluateTaskCase({
      task,
      result,
      expected: { requiredProvenanceKeys: ['contextFingerprint'] },
    });
    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
  });

  it('fails a contract mismatch instead of hiding it in a partial score', () => {
    const task: AiTask = {
      id: 'eval-task-fail',
      kind: 'creative.rewrite',
      input: {},
      outputContract: { format: 'patch' },
      effectPolicy: { mode: 'proposal' },
    };
    const report = evaluateTaskCase({
      task,
      result: { taskId: task.id, kind: task.kind, status: 'completed', output: { format: 'text', text: 'bad' } },
    });
    expect(report.passed).toBe(false);
    expect(report.checks.outputContract.passed).toBe(false);
    expect(report.checks.effectSafety.passed).toBe(false);
  });

  it('provides deterministic long-context and mutation evaluation helpers', () => {
    const benchmark = createLongContextBenchmark(300, 512);
    expect(benchmark.chapterCount).toBe(300);
    expect(benchmark.task.contextPolicy?.maxTokens).toBe(512);
    expect(
      runMutationChecks(
        benchmark.task,
        [{
          name: 'remove-budget',
          mutate: (task) => ({ ...task, contextPolicy: { maxTokens: 10 } }),
          expectedDetection: true,
        }],
        (task) => (task.contextPolicy?.maxTokens ?? 0) < 512,
      ),
    ).toEqual([{ name: 'remove-budget', passed: true }]);
  });
});
