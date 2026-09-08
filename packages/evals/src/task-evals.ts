import type { AiTask, OutputFormat, TaskResult } from '@inkpi/protocol';

export interface TaskEvaluationCase {
  task: AiTask;
  result: TaskResult;
  expected?: {
    status?: TaskResult['status'];
    outputFormat?: OutputFormat;
    requiredProvenanceKeys?: string[];
  };
}

export interface TaskEvaluationReport {
  taskId: string;
  kind: string;
  score: number;
  passed: boolean;
  checks: Record<string, { passed: boolean; score: number; details?: string }>;
}

export function evaluateTaskCase(input: TaskEvaluationCase): TaskEvaluationReport {
  const checks: TaskEvaluationReport['checks'] = {};
  const expectedStatus = input.expected?.status ?? 'completed';
  checks.status = {
    passed: input.result.status === expectedStatus,
    score: input.result.status === expectedStatus ? 100 : 0,
    details: `expected ${expectedStatus}, received ${input.result.status}`
  };
  const expectedFormat = input.expected?.outputFormat ?? input.task.outputContract?.format;
  const actualFormat = input.result.output?.format;
  checks.outputContract = {
    passed: expectedFormat === undefined || actualFormat === expectedFormat,
    score: expectedFormat === undefined || actualFormat === expectedFormat ? 100 : 0,
    details: expectedFormat ? `expected ${expectedFormat}, received ${actualFormat || 'none'}` : 'not specified'
  };
  const requiredKeys = input.expected?.requiredProvenanceKeys || [];
  const provenance = input.result.provenance || {};
  checks.provenance = {
    passed: requiredKeys.every((key) => provenance[key] !== undefined),
    score:
      requiredKeys.length === 0
        ? 100
        : Math.round((requiredKeys.filter((key) => provenance[key] !== undefined).length / requiredKeys.length) * 100)
  };
  checks.effectSafety = {
    passed: input.task.effectPolicy?.mode !== 'proposal' || input.task.effectPolicy.requiresApproval === true,
    score: input.task.effectPolicy?.mode !== 'proposal' || input.task.effectPolicy.requiresApproval === true ? 100 : 0,
    details: 'proposal effects require explicit approval'
  };
  const values = Object.values(checks).map((check) => check.score);
  const score = values.length === 0 ? 0 : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
  return {
    taskId: input.task.id,
    kind: input.task.kind,
    score,
    passed: score >= 85 && Object.values(checks).every((check) => check.passed),
    checks
  };
}
