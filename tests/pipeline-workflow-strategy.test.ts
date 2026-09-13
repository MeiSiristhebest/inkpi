import type { PipelineHooks, WorkflowContext } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import { genericWorkflowStrategy } from '../packages/agent-core/src/pipeline/workflow-strategy.js';

function makeCtx(): WorkflowContext {
  return {
    id: 'c1',
    userPrompt: 'write',
    stateLedger: { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] },
    stageOutputs: {},
    stageLogs: []
  };
}

const ISSUES = [{ type: 't', description: 'd', severity: 'critical' as const }];

describe('workflow strategy: generic domain-neutral behavior', () => {
  it('keeps the generic strategy neutral and does not invoke stage-name hooks', async () => {
    const calls: string[] = [];
    const hooks: PipelineHooks[] = [
      {
        onBeforeStage: ({ stageId }) => {
          calls.push(`before:${stageId}`);
          return 'hijacked';
        }
      }
    ];
    const prompt = await genericWorkflowStrategy.transformStagePrompt({
      stageId: 'outline',
      ctx: makeCtx(),
      prompt: 'original',
      hooks
    });
    expect(prompt).toBe('original');
    expect(calls).toEqual([]);
  });

  it('keeps both output transformation points as identity operations', async () => {
    const args = { stageId: 'polish', ctx: makeCtx(), output: 'done', hooks: [] };
    expect(await genericWorkflowStrategy.transformExecutedOutput(args)).toBe('done');
    expect(await genericWorkflowStrategy.transformSettledOutput(args)).toBe('done');
  });

  it('writes only canonical quality fields', () => {
    const ctx = makeCtx();
    genericWorkflowStrategy.applyGateIssues(ctx, ISSUES);
    expect(ctx.qualityIssues).toEqual(ISSUES);
  });

  it('emits only canonical quality gate events', () => {
    const triggered = genericWorkflowStrategy.buildGateTriggeredEvent({
      stageId: 's1',
      output: 'body',
      issues: ISSUES
    });
    expect(triggered).toEqual({
      type: 'quality_gate_triggered',
      issues: ISSUES,
      content: 'body',
      stageId: 's1'
    });

    const resolved = genericWorkflowStrategy.buildGateResolvedEvent({
      stageId: 's1',
      decision: { approved: true, modifiedContent: 'new', feedback: 'ok' }
    });
    expect(resolved).toEqual({
      type: 'quality_gate_resolved',
      approved: true,
      modifiedContent: 'new',
      feedback: 'ok',
      stageId: 's1'
    });
  });

  it('does not add domain aliases to gate events or stage output context', () => {
    const ctx = makeCtx();
    const event: Record<string, unknown> = { stageId: 's1' };
    genericWorkflowStrategy.decorateGateHandlerEvent(event as never, ctx, 'body');
    genericWorkflowStrategy.applyStageOutputAliases(ctx, 'outline', 'body');
    expect(event).toEqual({ stageId: 's1' });
    expect(ctx.stageOutputs).toEqual({});
  });
});
