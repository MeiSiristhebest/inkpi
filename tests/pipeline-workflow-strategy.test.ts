import type { PipelineHooks } from '@inkpi/protocol';
import type { WorkflowContext } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';
import {
  genericWorkflowStrategy,
  legacyPipelineWorkflowStrategy,
  resolveWorkflowStrategy
} from '../packages/agent-core/src/pipeline/workflow-strategy.js';

function makeCtx(): WorkflowContext {
  return {
    id: 'c1',
    title: 'Doc',
    sectionTitle: 'S1',
    bookTitle: 'Book',
    workspaceTitle: 'Workspace',
    chapterTitle: 'Ch1',
    documentTitle: 'Document',
    userPrompt: 'write',
    stateLedger: { entities: [], assets: [], tracks: [], locations: [], modifiedResources: [] } as any,
    stageOutputs: {},
    stageLogs: []
  };
}

const ISSUES = [{ type: 't', description: 'd', severity: 'critical' as const }];

describe('workflow strategy: 模式选择', () => {
  it("'legacy-pipeline' 解析为兼容策略", () => {
    expect(resolveWorkflowStrategy('legacy-pipeline')).toBe(legacyPipelineWorkflowStrategy);
  });

  it('未指定与未知模式都回落到中性策略，不静默启用兼容行为', () => {
    expect(resolveWorkflowStrategy(undefined)).toBe(genericWorkflowStrategy);
    expect(resolveWorkflowStrategy('generic')).toBe(genericWorkflowStrategy);
    expect(resolveWorkflowStrategy('legacy-PIPELINE')).toBe(genericWorkflowStrategy);
  });

  it('只有兼容模式保留账本旧字段别名', () => {
    expect(genericWorkflowStrategy.includeLedgerAliases).toBe(false);
    expect(legacyPipelineWorkflowStrategy.includeLedgerAliases).toBe(true);
  });
});

describe('workflow strategy: 提示词改写', () => {
  it('中性模式不改写提示词', async () => {
    const hooks: PipelineHooks[] = [{ onBeforeOutline: () => 'hijacked' }];
    const out = await genericWorkflowStrategy.transformStagePrompt({
      stageId: 'outline',
      ctx: makeCtx(),
      prompt: 'original',
      hooks
    });
    expect(out).toBe('original');
  });

  it('兼容模式仅在 outline 阶段调用 onBeforeOutline', async () => {
    const seen: string[] = [];
    const hooks: PipelineHooks[] = [
      {
        onBeforeOutline: (c) => {
          seen.push(c.userPrompt);
          return 'rewritten';
        }
      }
    ];
    const outlineOut = await legacyPipelineWorkflowStrategy.transformStagePrompt({
      stageId: 'outline',
      ctx: makeCtx(),
      prompt: 'original',
      hooks
    });
    const draftOut = await legacyPipelineWorkflowStrategy.transformStagePrompt({
      stageId: 'draft',
      ctx: makeCtx(),
      prompt: 'original',
      hooks
    });
    expect(outlineOut).toBe('rewritten');
    expect(draftOut).toBe('original');
    expect(seen).toEqual(['original']);
  });

  it('钩子返回空值时保留原提示词', async () => {
    const hooks: PipelineHooks[] = [{ onBeforeOutline: () => undefined }];
    const out = await legacyPipelineWorkflowStrategy.transformStagePrompt({
      stageId: 'outline',
      ctx: makeCtx(),
      prompt: 'keep',
      hooks
    });
    expect(out).toBe('keep');
  });
});

describe('workflow strategy: 产出改写', () => {
  it('兼容模式在 draft 阶段调用 onDraftGenerated 并改写产出', async () => {
    const hooks: PipelineHooks[] = [
      {
        onDraftGenerated: (c) => `${c.draftText}+draft`
      }
    ];
    const out = await legacyPipelineWorkflowStrategy.transformExecutedOutput({
      stageId: 'draft',
      ctx: makeCtx(),
      output: 'body',
      hooks
    });
    expect(out).toBe('body+draft');
  });

  it('兼容模式在 audit 阶段只通知 onAuditPass，不改写产出', async () => {
    const seen: Array<{ auditNotes: string[]; passed: boolean }> = [];
    const hooks: PipelineHooks[] = [
      {
        onAuditPass: (c) => {
          seen.push(c);
        }
      }
    ];
    const out = await legacyPipelineWorkflowStrategy.transformExecutedOutput({
      stageId: 'audit',
      ctx: makeCtx(),
      output: 'notes',
      hooks
    });
    expect(out).toBe('notes');
    expect(seen).toEqual([{ auditNotes: ['notes'], passed: true }]);
  });

  it('polish 钩子在 settled 阶段生效，而非 executed 阶段', async () => {
    const hooks: PipelineHooks[] = [{ onPolishDone: (c) => `${c.polishedText}!` }];
    const args = { stageId: 'polish', ctx: makeCtx(), output: 'done', hooks };

    const executed = await legacyPipelineWorkflowStrategy.transformExecutedOutput(args);
    expect(executed).toBe('done');

    const settled = await legacyPipelineWorkflowStrategy.transformSettledOutput(args);
    expect(settled).toBe('done!');
  });

  it('中性模式两个改写点都是恒等变换', async () => {
    const args = { stageId: 'polish', ctx: makeCtx(), output: 'x', hooks: [] };
    expect(await genericWorkflowStrategy.transformExecutedOutput(args)).toBe('x');
    expect(await genericWorkflowStrategy.transformSettledOutput(args)).toBe('x');
  });
});

describe('workflow strategy: 门禁事件', () => {
  it('中性模式写 quality* 字段，不写 plotGateIssues', () => {
    const ctx = makeCtx();
    genericWorkflowStrategy.applyGateIssues(ctx, ISSUES as any);
    expect(ctx.qualityIssues).toEqual(ISSUES);
    expect(ctx.qualityGateIssues).toEqual(ISSUES);
    expect(ctx.plotGateIssues).toBeUndefined();
  });

  it('兼容模式额外写 plotGateIssues', () => {
    const ctx = makeCtx();
    legacyPipelineWorkflowStrategy.applyGateIssues(ctx, ISSUES as any);
    expect(ctx.plotGateIssues).toEqual(ISSUES);
  });

  it('中性模式使用 quality_gate_* 事件名且不带 outlineText', () => {
    const event = genericWorkflowStrategy.buildGateTriggeredEvent({
      stageId: 's1',
      output: 'body',
      issues: ISSUES as any
    });
    expect(event.type).toBe('quality_gate_triggered');
    expect(event.content).toBe('body');
    expect(event.outlineText).toBeUndefined();
  });

  it('兼容模式使用 plot_gate_* 事件名并带 outlineText', () => {
    const event = legacyPipelineWorkflowStrategy.buildGateTriggeredEvent({
      stageId: 's1',
      output: 'body',
      issues: ISSUES as any
    });
    expect(event.type).toBe('plot_gate_triggered');
    expect(event.outlineText).toBe('body');
  });

  it('中性裁决事件携带 modifiedContent', () => {
    const event = genericWorkflowStrategy.buildGateResolvedEvent({
      stageId: 's1',
      decision: { approved: true, modifiedContent: 'new', feedback: 'ok' }
    });
    expect(event).toMatchObject({ type: 'quality_gate_resolved', modifiedContent: 'new' });
  });

  it('兼容裁决事件把 modifiedContent 折叠进 modifiedOutlineText', () => {
    const event = legacyPipelineWorkflowStrategy.buildGateResolvedEvent({
      stageId: 's1',
      decision: { approved: true, modifiedContent: 'new' }
    });
    expect(event).toMatchObject({ type: 'plot_gate_resolved', modifiedOutlineText: 'new' });
    expect((event as { modifiedContent?: string }).modifiedContent).toBeUndefined();
  });

  it('兼容裁决事件在无 modifiedContent 时回落到 modifiedOutlineText', () => {
    const event = legacyPipelineWorkflowStrategy.buildGateResolvedEvent({
      stageId: 's1',
      decision: { approved: false, modifiedOutlineText: 'legacy' }
    });
    expect(event).toMatchObject({ modifiedOutlineText: 'legacy' });
  });
});

describe('workflow strategy: 门禁处理器事件装饰', () => {
  it('中性模式不补充任何字段', () => {
    const event: Record<string, unknown> = { stageId: 's1' };
    genericWorkflowStrategy.decorateGateHandlerEvent(event as any, makeCtx(), 'body');
    expect(Object.keys(event)).toEqual(['stageId']);
  });

  it('兼容模式补充 5 个旧字段', () => {
    const ctx = makeCtx();
    const event: Record<string, unknown> = { stageId: 's1' };
    legacyPipelineWorkflowStrategy.decorateGateHandlerEvent(event as any, ctx, 'body');
    expect(event).toMatchObject({
      workspaceTitle: 'Workspace',
      documentTitle: 'Document',
      bookTitle: 'Book',
      chapterTitle: 'Ch1',
      outlineText: 'body'
    });
  });
});

describe('workflow strategy: 阶段产出别名', () => {
  it('中性模式不写任何别名', () => {
    const ctx = makeCtx();
    genericWorkflowStrategy.applyStageOutputAliases(ctx, 'outline', 'body');
    expect(ctx.outlineText).toBeUndefined();
  });

  it('兼容模式按阶段名写入对应别名', () => {
    const ctx = makeCtx();
    legacyPipelineWorkflowStrategy.applyStageOutputAliases(ctx, 'outline', 'o');
    legacyPipelineWorkflowStrategy.applyStageOutputAliases(ctx, 'draft', 'd');
    legacyPipelineWorkflowStrategy.applyStageOutputAliases(ctx, 'audit', 'a');
    legacyPipelineWorkflowStrategy.applyStageOutputAliases(ctx, 'polish', 'p');
    expect(ctx.outlineText).toBe('o');
    expect(ctx.draftText).toBe('d');
    expect(ctx.auditNotes).toEqual(['a']);
    expect(ctx.polishedText).toBe('p');
  });

  it('未登记的阶段名不写别名', () => {
    const ctx = makeCtx();
    legacyPipelineWorkflowStrategy.applyStageOutputAliases(ctx, 'custom', 'x');
    expect(ctx.outlineText).toBeUndefined();
  });
});
