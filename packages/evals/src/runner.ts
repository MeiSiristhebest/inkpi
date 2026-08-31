export interface EvaluationInput {
  title?: string;
  sectionTitle?: string;
  content: string;
  metadata?: Record<string, unknown>;
}

export interface EvaluationMetricResult {
  score: number;
  passed?: boolean;
  [key: string]: unknown;
}

export interface EvaluationMetric {
  id: string;
  weight?: number;
  evaluate: (input: EvaluationInput) => EvaluationMetricResult;
}

export interface GenericBenchmarkReport {
  title: string;
  sectionTitle?: string;
  overallScore: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'F';
  passed: boolean;
  timestamp: number;
  metrics: Record<string, EvaluationMetricResult>;
}

/**
 * Generic metric runner.
 *
 * Domain-specific scoring belongs to explicitly constructed adapters. This
 * module intentionally has no knowledge of any content domain.
 */
export class EvalRunner {
  private metrics = new Map<string, EvaluationMetric>();

  constructor(metrics: EvaluationMetric[] = []) {
    for (const metric of metrics) this.registerMetric(metric);
  }

  public registerMetric(metric: EvaluationMetric): this {
    if (!metric.id.trim()) throw new Error('Evaluation metric id must not be empty.');
    if (metric.weight !== undefined && (!Number.isFinite(metric.weight) || metric.weight < 0)) {
      throw new Error(`Evaluation metric '${metric.id}' has an invalid weight.`);
    }
    this.metrics.set(metric.id, metric);
    return this;
  }

  public unregisterMetric(id: string): boolean {
    return this.metrics.delete(id);
  }

  public getMetrics(): EvaluationMetric[] {
    return Array.from(this.metrics.values());
  }

  public evaluate(input: EvaluationInput): GenericBenchmarkReport {
    const metrics: Record<string, EvaluationMetricResult> = {};
    const registered = this.getMetrics();
    const totalWeight = registered.reduce((sum, metric) => sum + (metric.weight ?? 1), 0);
    let weightedScore = 0;

    for (const metric of registered) {
      const result = metric.evaluate(input);
      if (!Number.isFinite(result.score) || result.score < 0 || result.score > 100) {
        throw new Error(`Evaluation metric '${metric.id}' returned a score outside 0-100.`);
      }
      metrics[metric.id] = result;
      weightedScore += result.score * (metric.weight ?? 1);
    }

    const overallScore = totalWeight === 0 ? 0 : Math.round(weightedScore / totalWeight);
    const grade = overallScore >= 95 ? 'S' : overallScore >= 85 ? 'A' : overallScore >= 75 ? 'B' : overallScore >= 60 ? 'C' : 'F';
    return {
      title: input.title || '',
      sectionTitle: input.sectionTitle,
      overallScore,
      grade,
      passed: totalWeight > 0 && overallScore >= 75 && Object.values(metrics).every((metric) => metric.passed !== false),
      timestamp: Date.now(),
      metrics
    };
  }

}
