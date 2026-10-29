import { BranchSummarizer, SessionTree } from '@inkpi/agent-core';
import type { SummaryGenerationRequest } from '@inkpi/agent-core';
import type { AgentMessage, AssistantMessage, UserMessage } from '@inkpi/protocol';
import { describe, expect, it } from 'vitest';

describe('@inkpi/agent-core -> BranchSummarization & Session Tree LCA', () => {
  it('should compute Lowest Common Ancestor (LCA) between arbitrary tree nodes correctly', () => {
    const tree = new SessionTree();

    tree.addMessage({ role: 'user', content: '根设定：仙侠世界观' } as UserMessage);
    const nodeA1 = tree.addMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '设定已确认' }]
    } as AssistantMessage);

    // Branch 1
    const nodeB1 = tree.addMessage({ role: 'user', content: '分支1：主角选择Guild A' } as UserMessage);
    const leaf1 = tree.addMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '拜入Guild A下' }]
    } as AssistantMessage);

    // Branch 2 from nodeA1
    tree.selectLeaf(nodeA1);
    const nodeC1 = tree.addMessage({ role: 'user', content: '分支2：主角选择魔道万毒门' } as UserMessage);
    const leaf2 = tree.addMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '拜入万毒门下' }]
    } as AssistantMessage);

    expect(tree.findCommonAncestor(leaf1, leaf2)).toBe(nodeA1);
    expect(tree.findCommonAncestor(nodeB1, nodeC1)).toBe(nodeA1);
    expect(tree.findCommonAncestor(leaf1, nodeB1)).toBe(nodeB1);
    expect(tree.findCommonAncestor(leaf1, leaf1)).toBe(leaf1);
  });

  it('should collect diverging nodes and generate structured branch summary on branch switch', async () => {
    const tree = new SessionTree();

    tree.addMessage({ role: 'user', content: '大纲：第一folder' } as UserMessage);
    const rootAssistant = tree.addMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '大纲构建完毕' }]
    } as AssistantMessage);

    // Draft Line A (Abandoned)
    tree.addMessage({ role: 'user', content: '试写：主角在客栈直接杀死反派' } as UserMessage);
    const leafA = tree.addMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '反派当场毙命，剧情节奏过快' }]
    } as AssistantMessage);

    // Fork Line B from rootAssistant
    tree.selectLeaf(rootAssistant);
    const leafB = tree.addMessage({ role: 'user', content: '试写：主角选择隐忍调查' } as UserMessage);

    let now = 1000;
    const summarizer = new BranchSummarizer(async () => 'Summary of the abandoned route.', {
      idGenerator: () => 'summary_1',
      clock: () => ++now
    });

    const result = await summarizer.switchBranchWithSummary(tree, leafB, leafA);

    expect(result).not.toBeNull();
    expect(result!.summaryDetails.commonAncestorId).toBe(rootAssistant);
    expect(result!.summaryDetails.divergedNodeCount).toBe(2);
    expect(result!.summaryDetails.summary).toBe('Summary of the abandoned route.');

    const history = tree.getHistory(tree.getCurrentLeafId()!);
    const lastMsg = history[history.length - 1];
    expect(lastMsg.role).toBe('assistant');
    if (lastMsg.role === 'assistant') {
      expect(lastMsg.content[0].type).toBe('text');
      expect((lastMsg.content[0] as any).text).toContain('Branch Summary');
      expect((lastMsg.content[0] as any).text).toContain('Summary of the abandoned route.');
      expect(lastMsg.id).toBe('summary_1');
      expect(lastMsg.timestamp).toBe(1001);
    }

    // Edge case: switch to the same leaf ID returns null
    const sameRes = await summarizer.switchBranchWithSummary(tree, tree.getCurrentLeafId()!);
    expect(sameRes).toBeNull();

    // Missing summarizer is an explicit capability error, not a fabricated summary.
    const defaultSummarizer = new BranchSummarizer();
    await expect(defaultSummarizer.summarizeBranch(tree, leafA, rootAssistant)).rejects.toThrow(
      'explicit summarizer capability'
    );
    await expect(defaultSummarizer.summarizeBranch(tree, 'missing', rootAssistant)).rejects.toThrow(
      "Source branch node 'missing' not found"
    );
    await expect(summarizer.switchBranchWithSummary(tree, 'missing', leafA)).rejects.toThrow(
      "Target branch node 'missing' not found"
    );
  });

  it('rejects an async branch summary if the tree changes before commit', async () => {
    const tree = new SessionTree();
    tree.addMessage({ role: 'user', content: 'root' } as UserMessage);
    const common = tree.addMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'base' }]
    } as AssistantMessage);
    const abandoned = tree.addMessage({ role: 'user', content: 'old route' } as UserMessage);
    tree.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } as AssistantMessage);
    tree.selectLeaf(common);
    const target = tree.addMessage({ role: 'user', content: 'new route' } as UserMessage);

    let finishSummary!: (summary: string) => void;
    const summaryPromise = new Promise<string>((resolve) => {
      finishSummary = resolve;
    });
    const summarizer = new BranchSummarizer(() => summaryPromise, { idGenerator: () => 'stale_summary' });
    const switchPromise = summarizer.switchBranchWithSummary(tree, target, abandoned);

    tree.navigate(abandoned);
    finishSummary('stale route summary');

    await expect(switchPromise).rejects.toThrow('Session tree changed while the branch summary was generated');
    expect(tree.getCurrentLeafId()).toBe(abandoned);
    expect(tree.getNode('stale_summary')).toBeUndefined();
  });

  it('keeps long summaries intact without a configured output cap and persists returned usage', async () => {
    const tree = new SessionTree();
    const common = tree.addMessage({ role: 'user', content: 'shared premise' } as UserMessage);
    const abandoned = tree.addMessage({ role: 'user', content: 'old route' } as UserMessage);
    tree.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } as AssistantMessage);
    tree.selectLeaf(common);
    const target = tree.addMessage({ role: 'user', content: 'new route' } as UserMessage);
    const longSummary = 'Summary content. '.repeat(2_100);
    let capturedInput = '';
    let capturedRequest: SummaryGenerationRequest | undefined;
    const summarizer = new BranchSummarizer(
      async (serialized, request) => {
        capturedInput = serialized;
        capturedRequest = request;
        return {
          text: longSummary,
          usage: { inputTokens: 40, outputTokens: 7, totalTokens: 47 }
        };
      },
      { summaryInputTokens: 400, idGenerator: () => 'long_summary' }
    );

    const result = await summarizer.switchBranchWithSummary(tree, target, abandoned);

    expect(result?.summaryDetails.summary).toBe(longSummary);
    expect(result?.summaryDetails.summary.length).toBeGreaterThan(32_000);
    expect(capturedInput.length).toBeLessThan(2_000);
    expect(capturedRequest).toMatchObject({ maxInputTokens: 400 });
    expect(capturedRequest?.contextWindowTokens).toBeUndefined();
    expect(capturedRequest?.maxOutputTokens).toBeUndefined();
    const summaryMessage = tree.getHistory(tree.getCurrentLeafId()!).at(-1);
    expect(summaryMessage).toMatchObject({
      role: 'assistant',
      usage: { inputTokens: 40, outputTokens: 7, totalTokens: 47 }
    });
  });

  it('passes known branch summarizer limits and rejects output beyond an explicit cap', async () => {
    const tree = new SessionTree();
    const common = tree.addMessage({ role: 'user', content: 'shared premise' } as UserMessage);
    const abandoned = tree.addMessage({ role: 'user', content: 'old route' } as UserMessage);
    tree.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } as AssistantMessage);
    tree.selectLeaf(common);
    const target = tree.addMessage({ role: 'user', content: 'new route' } as UserMessage);
    let capturedRequest: SummaryGenerationRequest | undefined;
    const summarizer = new BranchSummarizer(
      async (_serialized, request) => {
        capturedRequest = request;
        return 'brief';
      },
      {
        summaryInputTokens: 200,
        summaryOutputTokens: 20,
        summaryContextWindowTokens: 2_000,
        summaryPromptTokens: 100
      }
    );

    await expect(summarizer.summarizeBranch(tree, abandoned, target)).resolves.toMatchObject({ summary: 'brief' });
    expect(capturedRequest).toMatchObject({
      maxInputTokens: 200,
      maxOutputTokens: 20,
      contextWindowTokens: 2_000
    });
    expect(capturedRequest?.remainingContextTokens).toBeGreaterThan(0);

    let contextOnlyRequest: SummaryGenerationRequest | undefined;
    const contextOnly = new BranchSummarizer(
      async (_serialized, request) => {
        contextOnlyRequest = request;
        return 'brief';
      },
      { summaryContextWindowTokens: 2_000, summaryPromptTokens: 100 }
    );
    await expect(contextOnly.summarizeBranch(tree, abandoned, target)).resolves.toMatchObject({ summary: 'brief' });
    expect(contextOnlyRequest?.maxOutputTokens).toBe(contextOnlyRequest?.remainingContextTokens);

    const tooLong = new BranchSummarizer(async () => 'this exceeds two tokens', { summaryOutputTokens: 2 });
    await expect(tooLong.summarizeBranch(tree, abandoned, target)).rejects.toThrow(
      'Branch summary exceeded the configured generation budget'
    );
  });

  it('passes AbortSignal to branch summarizer and does not switch or append a summary after cancellation', async () => {
    const tree = new SessionTree();
    const common = tree.addMessage({ role: 'user', content: 'shared premise' } as UserMessage);
    const abandoned = tree.addMessage({ role: 'user', content: 'old route' } as UserMessage);
    tree.addMessage({ role: 'assistant', content: [{ type: 'text', text: 'old answer' }] } as AssistantMessage);
    tree.selectLeaf(common);
    const target = tree.addMessage({ role: 'user', content: 'new route' } as UserMessage);
    const originalLeaf = tree.getCurrentLeafId();
    const originalRevision = tree.getRevision();
    const controller = new AbortController();
    let capturedRequest: SummaryGenerationRequest | undefined;
    let finishSummary!: (summary: string) => void;
    const pending = new Promise<string>((resolve) => {
      finishSummary = resolve;
    });
    const summarizer = new BranchSummarizer((_serialized, request) => {
      capturedRequest = request;
      return pending;
    });
    const switchPromise = summarizer.switchBranchWithSummary(tree, target, abandoned, controller.signal);

    controller.abort();
    finishSummary('cancelled summary');

    await expect(switchPromise).rejects.toThrow('Branch summarization aborted by signal');
    expect(capturedRequest?.signal).toBe(controller.signal);
    expect(tree.getCurrentLeafId()).toBe(originalLeaf);
    expect(tree.getRevision()).toBe(originalRevision);
    expect(
      tree
        .getHistory(originalLeaf!)
        .some(
          (message) =>
            message.role === 'assistant' &&
            message.content.some((block) => block.type === 'text' && block.text.includes('Branch Summary'))
        )
    ).toBe(false);
  });
});
