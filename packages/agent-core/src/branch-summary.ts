import type { AgentMessage, AssistantMessage, BranchSummaryDetails } from '@inkpi/protocol';
import { serializeConversationForSummary } from './compaction/summarize.js';
import type { SessionTree, SessionTreeNode } from './tree.js';

export class BranchSummarizer {
  private customSummarizer?: (serializedBranchText: string) => Promise<string>;
  private idGenerator: () => string;
  private clock: () => number;

  constructor(
    summarizer?: (serializedBranchText: string) => Promise<string>,
    options: { idGenerator?: () => string; clock?: () => number } = {}
  ) {
    this.customSummarizer = summarizer;
    this.clock = options.clock || Date.now;
    this.idGenerator = options.idGenerator || (() => `branch_summary_${this.clock()}`);
  }

  /**
   * 收集从 fromLeafId 到 LCA 祖先之间的已分叉/被废弃消息节点
   */
  public collectDivergingNodes(
    tree: SessionTree,
    fromLeafId: string,
    toLeafId: string
  ): {
    divergedNodes: SessionTreeNode[];
    commonAncestorId: string | null;
  } {
    if (!tree.getNode(fromLeafId)) {
      throw new Error(`Source branch node '${fromLeafId}' not found`);
    }
    if (!tree.getNode(toLeafId)) {
      throw new Error(`Target branch node '${toLeafId}' not found`);
    }
    const commonAncestorId = tree.findCommonAncestor(fromLeafId, toLeafId);
    const divergedNodes: SessionTreeNode[] = [];

    let curr = tree.getNode(fromLeafId);
    while (curr && curr.id !== commonAncestorId) {
      divergedNodes.unshift(curr);
      if (!curr.parentId) break;
      curr = tree.getNode(curr.parentId);
    }

    return {
      divergedNodes,
      commonAncestorId
    };
  }

  /**
   * 汇总被放弃分支的推演成果与试写内容
   */
  public async summarizeBranch(
    tree: SessionTree,
    fromLeafId: string,
    toLeafId: string
  ): Promise<BranchSummaryDetails | null> {
    const { divergedNodes, commonAncestorId } = this.collectDivergingNodes(tree, fromLeafId, toLeafId);

    if (divergedNodes.length === 0) {
      return null;
    }

    const messages = divergedNodes.map((n) => n.message);
    const serialized = serializeConversationForSummary(messages);

    let summaryText = '';
    if (!this.customSummarizer) {
      throw new Error('Branch summarization requires an explicit summarizer capability.');
    }
    summaryText = await this.customSummarizer(serialized);

    const discardedIdeas: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        discardedIdeas.push(`Input: ${text.slice(0, 50)}`);
      }
    }

    return {
      fromLeafId,
      toLeafId,
      commonAncestorId,
      divergedNodeCount: divergedNodes.length,
      summary: summaryText,
      discardedIdeas
    };
  }

  /**
   * 构造分支切换总结消息，供注入新分支上下文
   */
  public createBranchSummaryMessage(details: BranchSummaryDetails): AssistantMessage {
    return {
      id: this.idGenerator(),
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `【Branch Summary】\n${details.summary}`
        }
      ],
      stopReason: 'stop',
      timestamp: this.clock()
    };
  }

  /**
   * 一键切换分支并自动将旧分支探索总结追加到目标分支头部
   */
  public async switchBranchWithSummary(
    tree: SessionTree,
    toLeafId: string,
    fromLeafId?: string
  ): Promise<{ summaryDetails: BranchSummaryDetails; summaryNodeId: string } | null> {
    const effectiveFromId = fromLeafId || tree.getCurrentLeafId();
    if (!tree.getNode(toLeafId)) {
      throw new Error(`Target branch node '${toLeafId}' not found`);
    }
    if (!effectiveFromId || effectiveFromId === toLeafId) {
      tree.selectLeaf(toLeafId);
      return null;
    }

    const details = await this.summarizeBranch(tree, effectiveFromId, toLeafId);
    tree.selectLeaf(toLeafId);

    if (!details || details.divergedNodeCount === 0) {
      return null;
    }

    const summaryMsg = this.createBranchSummaryMessage(details);

    const summaryNodeId = tree.addMessage(summaryMsg, toLeafId, {
      type: 'branch_summary',
      details
    });

    return {
      summaryDetails: details,
      summaryNodeId
    };
  }
}
