import type { AgentMessage, AssistantMessage, BranchSummaryDetails } from '@inkpi/protocol';
import type { SessionTree, SessionTreeNode } from './tree.js';
import { serializeConversationForSummary } from './compaction/utils.js';

export class BranchSummarizer {
  private customSummarizer?: (serializedBranchText: string) => Promise<string>;

  constructor(summarizer?: (serializedBranchText: string) => Promise<string>) {
    this.customSummarizer = summarizer;
  }

  /**
   * 收集从 fromLeafId 到 LCA 祖先之间的已分叉/被废弃消息节点
   */
  public collectDivergingNodes(tree: SessionTree, fromLeafId: string, toLeafId: string): {
    divergedNodes: SessionTreeNode[];
    commonAncestorId: string | null;
  } {
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
   * 汇总被放弃分支的推演成果与试写内容 (1:1 对标 repos/pi BranchSummarization)
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
    if (this.customSummarizer) {
      summaryText = await this.customSummarizer(serialized);
    } else {
      summaryText = `【被放弃剧情分支探索摘要】\n共推演了 ${divergedNodes.length} 个回合，探索了以下走向：\n${serialized.slice(0, 300)}...`;
    }

    const discardedIdeas: string[] = [];
    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        discardedIdeas.push(`试探指令: ${text.slice(0, 50)}`);
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
      id: `branch_summary_${Date.now()}`,
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: `🌿 【分支剧情推演回溯摘要】\n(已从被放弃分支回溯至公共祖先，以下为探索经验归档)\n${details.summary}`
        }
      ],
      stopReason: 'stop',
      timestamp: Date.now()
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
    if (!effectiveFromId || effectiveFromId === toLeafId) {
      tree.navigate(toLeafId);
      return null;
    }

    const details = await this.summarizeBranch(tree, effectiveFromId, toLeafId);
    tree.navigate(toLeafId);

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
