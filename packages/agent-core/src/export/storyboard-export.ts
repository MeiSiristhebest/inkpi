import type { AgentMessage, ExportOptions, QualityGateIssue, StateLedger, UsageTotals } from '@meisiristhebest/protocol';
import type { UsageCostBreakdown } from '@meisiristhebest/ai';
import type { SessionTree } from '../tree.js';
import {
  SessionReportExporter,
  type SessionReportBranchSummary,
  type SessionReportExportOptions
} from './session-report-export.js';

export interface StoryboardExportOptions extends Partial<ExportOptions> {
  title?: string;
  author?: string;
  ledger?: StateLedger;
  gateIssues?: QualityGateIssue[];
  usageTotals?: UsageTotals;
  costBreakdown?: UsageCostBreakdown;
  whatIfSummaries?: Array<{ branchName: string; summaryText: string; entityDiffCount: number }>;
}

/**
 * Legacy narrative presentation adapter.
 *
 * The generic report renderer lives in SessionReportExporter. This adapter
 * keeps the old public API without making narrative labels part of the core.
 */
export class StoryboardExporter {
  public static exportToStoryboardHtml(
    messages: AgentMessage[],
    options: StoryboardExportOptions = {},
    tree?: SessionTree
  ): string {
    const branchSummaries: SessionReportBranchSummary[] = (options.whatIfSummaries || []).map((item) => ({
      branchName: item.branchName,
      summaryText: item.summaryText,
      differenceCount: item.entityDiffCount
    }));
    const reportOptions: SessionReportExportOptions = {
      ...options,
      branchSummaries,
      labels: {
        user: '作者指令',
        assistant: 'AI 创作响应',
        thinking: '深度推演思考过程',
        toolCall: '调用工具',
        toolResult: '工具执行回包',
        timeline: '创作演进时间轴',
        ledger: '实体状态账本',
        branches: 'What-If 平行世界',
        gates: '质量门禁审计',
        entities: '人物与关键角色',
        assets: '关键道具与资产',
        tracks: '追踪项',
        emptyLedger: '暂无提取的状态账本实体。',
        emptyBranches: '暂无平行推演分支。',
        gatesPassed: '质量门禁检测全部通过，未发现逻辑崩坏或设定矛盾。',
        totalTokens: '总 Token 消耗',
        inputTokens: '输入 Prompt Tokens',
        outputTokens: '生成 Output Tokens',
        cachedTokens: 'Prompt Cache 命中',
        cost: '总创作成本 (USD)',
        branch: '分支线',
        differenceCount: '影响状态节点数',
        exportedBy: '创作者',
        unknown: '未知',
        active: '正常'
      }
    };
    return new SessionReportExporter().exportToHtml(messages, reportOptions, tree);
  }
}
