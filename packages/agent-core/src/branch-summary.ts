import type { AgentMessage, AssistantMessage, BranchSummaryDetails, Usage } from '@inkpi/protocol';
import {
  SUMMARY_SERIALIZATION_DEFAULTS,
  estimateSummaryTokens,
  reportedSummaryInputTokens,
  reportedSummaryOutputTokens,
  serializeConversationForSummary
} from './compaction/summarize.js';
import type { SummaryGenerationOutput, SummaryGenerationRequest } from './compaction/summarize.js';
import type { SessionTree, SessionTreeNode } from './tree.js';

export interface BranchSummarizerOptions {
  idGenerator?: () => string;
  clock?: () => number;
  /** Estimated-token ceiling for serialized branch input. */
  summaryInputTokens?: number;
  /** Explicit generation limit supported by the configured summarizer. */
  summaryOutputTokens?: number;
  /** Context window of the summarizer model, when known. */
  summaryContextWindowTokens?: number;
  /** Estimated fixed prompt overhead, if known by the callback owner. */
  summaryPromptTokens?: number;
}

export class BranchSummarizer {
  private customSummarizer?: (
    serializedBranchText: string,
    request: SummaryGenerationRequest
  ) => Promise<SummaryGenerationOutput>;
  private idGenerator: () => string;
  private clock: () => number;
  private summaryInputTokens?: number;
  private summaryOutputTokens?: number;
  private summaryContextWindowTokens?: number;
  private summaryPromptTokens?: number;

  constructor(
    summarizer?: (serializedBranchText: string, request: SummaryGenerationRequest) => Promise<SummaryGenerationOutput>,
    options: BranchSummarizerOptions = {}
  ) {
    this.customSummarizer = summarizer;
    this.clock = options.clock || Date.now;
    this.idGenerator = options.idGenerator || (() => `branch_summary_${this.clock()}`);
    this.summaryInputTokens = positiveIntegerOrUndefined(options.summaryInputTokens);
    this.summaryOutputTokens = positiveIntegerOrUndefined(options.summaryOutputTokens);
    this.summaryContextWindowTokens = positiveIntegerOrUndefined(options.summaryContextWindowTokens);
    this.summaryPromptTokens = nonNegativeIntegerOrUndefined(options.summaryPromptTokens);
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
    toLeafId: string,
    signal?: AbortSignal
  ): Promise<BranchSummaryDetails | null> {
    return (await this.summarizeBranchWithUsage(tree, fromLeafId, toLeafId, signal))?.details ?? null;
  }

  public async summarizeBranchWithUsage(
    tree: SessionTree,
    fromLeafId: string,
    toLeafId: string,
    signal?: AbortSignal
  ): Promise<{ details: BranchSummaryDetails; usage?: Usage } | null> {
    if (signal?.aborted) throw new Error('Branch summarization aborted by signal');
    const { divergedNodes, commonAncestorId } = this.collectDivergingNodes(tree, fromLeafId, toLeafId);
    if (divergedNodes.length === 0) return null;

    if (!this.customSummarizer) {
      throw new Error('Branch summarization requires an explicit summarizer capability.');
    }
    const messages = divergedNodes.map((node) => node.message);
    const maxInputTokens = this.summaryInputTokens ?? SUMMARY_SERIALIZATION_DEFAULTS.maxInputTokens;
    const serialized = serializeConversationForSummary(messages, { maxInputTokens });
    const estimatedInputTokens = estimateSummaryTokens(serialized) + (this.summaryPromptTokens ?? 0);
    const remainingContextTokens =
      this.summaryContextWindowTokens !== undefined && this.summaryPromptTokens !== undefined
        ? Math.max(0, this.summaryContextWindowTokens - estimatedInputTokens)
        : undefined;
    let maxOutputTokens = this.summaryOutputTokens;
    if (remainingContextTokens !== undefined) {
      maxOutputTokens =
        maxOutputTokens === undefined ? remainingContextTokens : Math.min(maxOutputTokens, remainingContextTokens);
    }
    if (remainingContextTokens === 0) {
      throw new Error('Branch summary input leaves no context window for generated output.');
    }
    const request: SummaryGenerationRequest = {
      signal,
      maxInputTokens,
      estimatedInputTokens,
      ...(this.summaryContextWindowTokens !== undefined
        ? { contextWindowTokens: this.summaryContextWindowTokens }
        : {}),
      ...(remainingContextTokens !== undefined ? { remainingContextTokens } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {})
    };
    const generated = await this.customSummarizer(serialized, request);
    if (signal?.aborted) throw new Error('Branch summarization aborted by signal');
    const summaryText = typeof generated === 'string' ? generated : generated.text;
    const usage = typeof generated === 'string' ? undefined : generated.usage;
    const estimatedOutputTokens = estimateSummaryTokens(summaryText);
    const reportedOutputTokens = usage ? reportedSummaryOutputTokens(usage) : estimatedOutputTokens;
    let actualRemainingContextTokens = remainingContextTokens;
    if (usage && this.summaryContextWindowTokens !== undefined) {
      actualRemainingContextTokens = this.summaryContextWindowTokens - reportedSummaryInputTokens(usage);
    }
    if (
      (maxOutputTokens !== undefined && reportedOutputTokens > maxOutputTokens) ||
      (actualRemainingContextTokens !== undefined &&
        (actualRemainingContextTokens < 0 || reportedOutputTokens > actualRemainingContextTokens))
    ) {
      throw new Error('Branch summary exceeded the configured generation budget.');
    }

    const discardedIdeas: string[] = [];
    for (const message of messages) {
      if (message.role === 'user') {
        const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        discardedIdeas.push(`Input: ${text.slice(0, 50)}`);
      }
    }

    return {
      details: {
        fromLeafId,
        toLeafId,
        commonAncestorId,
        divergedNodeCount: divergedNodes.length,
        summary: summaryText,
        discardedIdeas
      },
      usage
    };
  }

  /**
   * 构造分支切换总结消息，供注入新分支上下文
   */
  public createBranchSummaryMessage(details: BranchSummaryDetails, usage?: Usage): AssistantMessage {
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
      ...(usage ? { usage } : {}),
      timestamp: this.clock()
    };
  }

  /**
   * 一键切换分支并自动将旧分支探索总结追加到目标分支头部
   */
  public async switchBranchWithSummary(
    tree: SessionTree,
    toLeafId: string,
    fromLeafId?: string,
    signal?: AbortSignal
  ): Promise<{ summaryDetails: BranchSummaryDetails; summaryNodeId: string } | null> {
    if (signal?.aborted) throw new Error('Branch summarization aborted by signal');
    const effectiveFromId = fromLeafId || tree.getCurrentLeafId();
    if (!tree.getNode(toLeafId)) {
      throw new Error(`Target branch node '${toLeafId}' not found`);
    }
    if (!effectiveFromId || effectiveFromId === toLeafId) {
      tree.selectLeaf(toLeafId);
      return null;
    }

    const revision = tree.getRevision();
    const generated = await this.summarizeBranchWithUsage(tree, effectiveFromId, toLeafId, signal);
    if (signal?.aborted) throw new Error('Branch summarization aborted by signal');
    if (tree.getRevision() !== revision) {
      throw new Error('Session tree changed while the branch summary was generated; retry the branch switch.');
    }
    tree.selectLeaf(toLeafId);

    if (!generated || generated.details.divergedNodeCount === 0) {
      return null;
    }

    const details = generated.details;
    const summaryMsg = this.createBranchSummaryMessage(details, generated.usage);

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

function positiveIntegerOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeIntegerOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
