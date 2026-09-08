import type { AiTask } from '@inkpi/protocol';

export interface EvalMutation {
  name: string;
  mutate(task: AiTask): AiTask;
  expectedDetection: boolean;
}

export interface LongContextBenchmark {
  chapterCount: number;
  task: AiTask;
  expectedMaxTokens: number;
}

export function createLongContextBenchmark(chapterCount = 100, maxTokens = 2048): LongContextBenchmark {
  const safeCount = Math.max(1, Math.floor(chapterCount));
  return {
    chapterCount: safeCount,
    task: {
      id: `long-context-${safeCount}`,
      kind: 'narrative.continuity.audit',
      input: { text: Array.from({ length: safeCount }, (_, index) => `chapter-${index + 1}`).join('\n') },
      contextPolicy: { maxTokens },
      outputContract: { format: 'structured' },
      effectPolicy: { mode: 'read-only' },
    },
    expectedMaxTokens: maxTokens,
  };
}

export function runMutationChecks(
  task: AiTask,
  mutations: EvalMutation[],
  detect: (mutated: AiTask) => boolean,
): Array<{ name: string; passed: boolean }> {
  return mutations.map((mutation) => ({
    name: mutation.name,
    passed: detect(mutation.mutate(structuredClone(task))) === mutation.expectedDetection,
  }));
}
