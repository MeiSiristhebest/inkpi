import { ContextPipeline, TaskRegistry, TaskRouter } from '@inkpi/agent-core';
import type { AiTask, OutputFormat, TaskResult } from '@inkpi/protocol';
import type { TaskEvaluationCase, TaskEvaluationReport } from './task-evals.js';
import { evaluateTaskCase } from './task-evals.js';

export interface TaskEvalFixture {
  name: string;
  task: AiTask;
  expectedFormat: OutputFormat;
  requiredProvenanceKeys: string[];
}

export function createTaskEvalFixtures(): TaskEvalFixture[] {
  const base = (kind: string, format: OutputFormat): TaskEvalFixture => ({
    name: kind,
    task: {
      id: `fixture-${kind.replace(/[^a-z0-9]+/gi, '-')}`,
      kind,
      input: { text: 'fixture context' },
      outputContract: { format },
      effectPolicy: { mode: 'read-only' }
    },
    expectedFormat: format,
    requiredProvenanceKeys: ['provider', 'model']
  });
  return [
    base('creative.continue', 'text'),
    base('creative.rewrite', 'patch'),
    base('narrative.continuity.audit', 'structured'),
    base('narrative.deep.reason', 'structured'),
    base('narrative.project.distill', 'structured')
  ];
}

export function evaluateObjective(input: TaskEvaluationCase): TaskEvaluationReport {
  return evaluateTaskCase(input);
}

export function evaluateSubjective(
  report: TaskEvaluationReport,
  score: number,
  feedback?: string
): TaskEvaluationReport {
  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  const checks = {
    ...report.checks,
    subjective: { passed: bounded >= 85, score: bounded, details: feedback }
  };
  const scores = Object.values(checks).map((check) => check.score);
  const total = Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
  return {
    ...report,
    checks,
    score: total,
    passed: total >= 85 && Object.values(checks).every((check) => check.passed)
  };
}

export function mutateTask(task: AiTask, mutate: (task: AiTask) => AiTask): AiTask {
  return mutate(structuredClone(task));
}

export function longContextFixture(size = 20_000): AiTask {
  return {
    id: 'fixture-long-context',
    kind: 'narrative.continuity.audit',
    input: { text: 'context '.repeat(Math.max(1, size)) },
    contextPolicy: { maxTokens: 512 },
    outputContract: { format: 'structured' },
    effectPolicy: { mode: 'read-only' }
  };
}

export async function runDeterministicTaskFixture(task: AiTask): Promise<TaskResult> {
  const registry = new TaskRegistry();
  registry.register({
    id: 'fixture-handler',
    kinds: ['*'],
    async execute({ task: current, context }) {
      const format = current.outputContract?.format ?? 'text';
      const output =
        format === 'text'
          ? { format: 'text' as const, text: context.text }
          : format === 'patch'
            ? { format: 'patch' as const, patch: { from: 0, to: 0, text: context.text } }
            : { format: 'structured' as const, data: { contextFingerprint: context.fingerprint } };
      return {
        output,
        provenance: { provider: 'fixture', model: 'deterministic', contextFingerprint: context.fingerprint }
      };
    }
  });
  const router = new TaskRouter({ registry, contextPipeline: new ContextPipeline() });
  router.submit(task);
  return router.wait(task.id);
}
