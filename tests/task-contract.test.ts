import { evaluateTaskCase } from '@inkpi/evals';
import type { AiTask, EffectPolicy, ExecutionPolicy, OutputContract } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('domain-neutral AiTask contract', () => {
  it('keeps task kinds open and separates input from execution, output, and effects', () => {
    const executionPolicy: ExecutionPolicy = {
      strategy: 'reasoning',
      mode: 'interactive',
      cancellable: true
    };
    const outputContract: OutputContract = {
      format: 'patch',
      persistence: 'artifact'
    };
    const effectPolicy: EffectPolicy = {
      mode: 'proposal',
      requiresApproval: true
    };
    const task: AiTask = {
      id: 'task-1',
      kind: 'narrative.continuity.audit',
      input: {
        documentId: 'chapter-1',
        text: '当前章节'
      },
      executionPolicy,
      outputContract,
      effectPolicy
    };

    expect(task.kind).toBe('narrative.continuity.audit');
    expect(task.input).not.toHaveProperty('prompt');
    expect(task.executionPolicy).toBe(executionPolicy);
    expect(task.outputContract).toBe(outputContract);
    expect(task.effectPolicy).toBe(effectPolicy);
    expect(outputContract.format).toBe('patch');
    expect(outputContract.persistence).toBe('artifact');
  });

  it('does not make artifact persistence an output format', () => {
    const contract: OutputContract = { format: 'structured', persistence: 'artifact' };
    expect(['text', 'structured', 'patch']).toContain(contract.format);
    expect(contract.format).not.toBe('artifact');
  });

  it('keeps execution policy dimensions independent for conflicting client values', () => {
    const executionPolicy: ExecutionPolicy = {
      strategy: 'completion',
      mode: 'interactive',
      scheduling: 'batch',
      checkpointIntervalMs: 0,
      checkpoint: { enabled: false, step: '' },
      maxAttempts: 0
    };
    const task: AiTask = {
      id: 'policy-combination',
      kind: 'client.workflow',
      input: {},
      executionPolicy
    };

    expect(task.executionPolicy).toEqual(executionPolicy);
    expect(task.executionPolicy?.mode).toBe('interactive');
    expect(task.executionPolicy?.scheduling).toBe('batch');
    expect(task.executionPolicy?.checkpoint).toEqual({ enabled: false, step: '' });
  });

  it('marks a proposal without explicit approval as an invalid policy combination', () => {
    const task: AiTask = {
      id: 'unsafe-proposal',
      kind: 'test.policy',
      input: {},
      effectPolicy: { mode: 'proposal' }
    };
    const report = evaluateTaskCase({
      task,
      result: { taskId: task.id, kind: task.kind, status: 'completed' }
    });

    expect(report.passed).toBe(false);
    expect(report.checks.effectSafety).toMatchObject({ passed: false, score: 0 });
  });
});
