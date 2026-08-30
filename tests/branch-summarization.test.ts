import { describe, it, expect } from 'vitest';
import { SessionTree } from '@inkpi/agent-core';
import { BranchSummarizer } from '@inkpi/agent-core';
import type { AgentMessage, UserMessage, AssistantMessage } from '@inkpi/protocol';

describe('@inkpi/agent-core -> BranchSummarization & Session Tree LCA', () => {
  it('should compute Lowest Common Ancestor (LCA) between arbitrary tree nodes correctly', () => {
    const tree = new SessionTree();

    const rootId = tree.addMessage({ role: 'user', content: '根设定：仙侠世界观' } as UserMessage);
    const nodeA1 = tree.addMessage({ role: 'assistant', content: [{ type: 'text', text: '设定已确认' }] } as AssistantMessage);
    
    // Branch 1
    const nodeB1 = tree.addMessage({ role: 'user', content: '分支1：主角选择Guild A' } as UserMessage);
    const leaf1 = tree.addMessage({ role: 'assistant', content: [{ type: 'text', text: '拜入Guild A下' }] } as AssistantMessage);

    // Branch 2 from nodeA1
    tree.fork(nodeA1);
    const nodeC1 = tree.addMessage({ role: 'user', content: '分支2：主角选择魔道万毒门' } as UserMessage);
    const leaf2 = tree.addMessage({ role: 'assistant', content: [{ type: 'text', text: '拜入万毒门下' }] } as AssistantMessage);

    expect(tree.findCommonAncestor(leaf1, leaf2)).toBe(nodeA1);
    expect(tree.findCommonAncestor(nodeB1, nodeC1)).toBe(nodeA1);
    expect(tree.findCommonAncestor(leaf1, nodeB1)).toBe(nodeB1);
    expect(tree.findCommonAncestor(leaf1, leaf1)).toBe(leaf1);
  });

  it('should collect diverging nodes and generate structured branch summary on branch switch', async () => {
    const tree = new SessionTree();

    tree.addMessage({ role: 'user', content: '大纲：第一folder' } as UserMessage);
    const rootAssistant = tree.addMessage({ role: 'assistant', content: [{ type: 'text', text: '大纲构建完毕' }] } as AssistantMessage);

    // Draft Line A (Abandoned)
    tree.addMessage({ role: 'user', content: '试写：主角在客栈直接杀死反派' } as UserMessage);
    const leafA = tree.addMessage({
      role: 'assistant',
      content: [{ type: 'text', text: '反派当场毙命，剧情节奏过快' }]
    } as AssistantMessage);

    // Fork Line B from rootAssistant
    tree.fork(rootAssistant);
    const leafB = tree.addMessage({ role: 'user', content: '试写：主角选择隐忍调查' } as UserMessage);

    const summarizer = new BranchSummarizer(async (text) => `【废案总结】尝试了激进反杀路线，导致矛盾提前终结。`);

    const result = await summarizer.switchBranchWithSummary(tree, leafB, leafA);


    expect(result).not.toBeNull();
    expect(result!.summaryDetails.commonAncestorId).toBe(rootAssistant);
    expect(result!.summaryDetails.divergedNodeCount).toBe(2);
    expect(result!.summaryDetails.summary).toContain('【废案总结】尝试了激进反杀路线');

    const history = tree.getHistory(tree.getCurrentLeafId()!);
    const lastMsg = history[history.length - 1];
    expect(lastMsg.role).toBe('assistant');
    if (lastMsg.role === 'assistant') {
      expect(lastMsg.content[0].type).toBe('text');
      expect((lastMsg.content[0] as any).text).toContain('分支剧情推演回溯摘要');
    }

    // Edge case: switch to the same leaf ID returns null
    const sameRes = await summarizer.switchBranchWithSummary(tree, tree.getCurrentLeafId()!);
    expect(sameRes).toBeNull();

    // Default summarizer branch
    const defaultSummarizer = new BranchSummarizer();
    const defaultDetails = await defaultSummarizer.summarizeBranch(tree, leafA, rootAssistant);
    expect(defaultDetails).toBeDefined();
    expect(defaultDetails?.summary).toContain('被放弃剧情分支探索摘要');
  });
});

