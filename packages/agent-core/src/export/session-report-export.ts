import type { UsageCostBreakdown } from '@inkpi/ai';
import type {
  AgentMessage,
  ExportOptions,
  QualityGateIssue,
  RuntimeState,
  StateLedger,
  UsageTotals
} from '@inkpi/protocol';
import type { SessionTree } from '../tree.js';
import { escapeHtml } from './html.js';
import { REPORT_SCRIPT, REPORT_STYLE } from './report-assets.js';

export interface SessionReportBranchSummary {
  branchName: string;
  summaryText: string;
  differenceCount?: number;
}

export interface RuntimeSessionReportLabels {
  user: string;
  assistant: string;
  thinking: string;
  toolCall: string;
  toolResult: string;
  timeline: string;
  state: string;
  branches: string;
  gates: string;
  emptyState: string;
  emptyBranches: string;
  gatesPassed: string;
  totalTokens: string;
  inputTokens: string;
  outputTokens: string;
  cachedTokens: string;
  cost: string;
  branch: string;
  differenceCount: string;
  exportedBy: string;
  unknown: string;
  active: string;
  system: string;
  custom: string;
}

export interface SessionReportLabels extends RuntimeSessionReportLabels {
  /** Legacy creative labels used only by the compatibility adapter. */
  ledger: string;
  entities: string;
  assets: string;
  tracks: string;
  emptyLedger: string;
}

export interface RuntimeSessionReportStateSection {
  title: string;
  columns: readonly string[];
  rows: readonly (readonly string[])[];
}

export interface RuntimeSessionReportStateAdapter<TState extends RuntimeState = RuntimeState> {
  toSections(state: TState): readonly RuntimeSessionReportStateSection[];
}

export interface RuntimeSessionReportExportOptions<TState extends RuntimeState = RuntimeState>
  extends Partial<ExportOptions> {
  title?: string;
  author?: string;
  state?: TState;
  stateAdapter?: RuntimeSessionReportStateAdapter<TState>;
  gateIssues?: QualityGateIssue[];
  usageTotals?: UsageTotals;
  costBreakdown?: UsageCostBreakdown;
  branchSummaries?: SessionReportBranchSummary[];
  labels?: Partial<RuntimeSessionReportLabels>;
  /** Allows callers and tests to provide a stable export timestamp. */
  exportedAt?: string | number | Date;
}

/**
 * Legacy compatibility options. New Runtime callers should use
 * RuntimeSessionReportExportOptions and provide an opaque state adapter.
 */
export interface SessionReportExportOptions extends Omit<RuntimeSessionReportExportOptions<RuntimeState>, 'labels'> {
  /** @deprecated Use `state` with RuntimeSessionReportStateAdapter. */
  ledger?: StateLedger;
  labels?: Partial<SessionReportLabels>;
}

const DEFAULT_RUNTIME_LABELS: RuntimeSessionReportLabels = {
  user: 'User',
  assistant: 'Assistant',
  thinking: 'Thinking',
  toolCall: 'Tool Call',
  toolResult: 'Tool Result',
  timeline: 'Timeline',
  state: 'State',
  branches: 'Branches',
  gates: 'Quality Gates',
  emptyState: 'No state records.',
  emptyBranches: 'No branch summaries.',
  gatesPassed: 'No gate issues detected.',
  totalTokens: 'Total tokens',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cachedTokens: 'Cached tokens',
  cost: 'Cost (USD)',
  branch: 'Branch',
  differenceCount: 'Differences',
  exportedBy: 'Exported by',
  unknown: 'Unknown',
  active: 'active',
  system: 'System',
  custom: 'Custom'
};

const DEFAULT_LEGACY_LABELS: SessionReportLabels = {
  ...DEFAULT_RUNTIME_LABELS,
  ledger: 'State Ledger',
  entities: 'Entities',
  assets: 'Assets',
  tracks: 'Tracks',
  emptyLedger: 'No state records.'
};

/**
 * Generic, self-contained session/report exporter.
 *
 * The core renders protocol data only. Narrative wording, labels and
 * domain-specific projections belong to an adapter such as StoryboardExporter.
 */
export class RuntimeSessionReportExporter<TState extends RuntimeState = RuntimeState> {
  public exportToHtml(
    messages: AgentMessage[],
    options: RuntimeSessionReportExportOptions<TState> = {},
    tree?: SessionTree
  ): string {
    const labels = { ...DEFAULT_RUNTIME_LABELS, ...options.labels };
    const title = options.title || 'Session Report';
    const author = options.author;
    const branches = tree?.getBranches() || [];
    const branchSummaries = options.branchSummaries || [];
    const gateIssues = options.gateIssues || [];
    const exportedAt = formatTimestamp(options.exportedAt);

    const messagesHtml = messages
      .map((message, index) => this.renderMessage(message, index, options, labels))
      .join('\n');
    const stateHtml = this.renderState(options.state, options.stateAdapter, labels);
    const branchHtml = this.renderBranches(branchSummaries, branches.length, labels);
    const gateHtml = this.renderGates(gateIssues, labels);
    const usageHtml = this.renderUsage(options.usageTotals, labels);
    const attribution = author
      ? `${escapeHtml(labels.exportedBy)}: ${escapeHtml(author)}`
      : escapeHtml(labels.exportedBy);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
${REPORT_STYLE}  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${escapeHtml(title)}</h1>
      <div class="meta">${attribution} | ${escapeHtml(exportedAt)}</div>
    </header>
    ${usageHtml}
    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab(event, 'timeline')">${escapeHtml(labels.timeline)}</button>
      <button class="tab-btn" onclick="switchTab(event, 'state')">${escapeHtml(labels.state)}</button>
      <button class="tab-btn" onclick="switchTab(event, 'branches')">${escapeHtml(labels.branches)} (${branchSummaries.length || branches.length})</button>
      <button class="tab-btn" onclick="switchTab(event, 'gates')">${escapeHtml(labels.gates)} (${gateIssues.length})</button>
    </div>
    <div id="tab-timeline" class="tab-panel active">${messagesHtml}</div>
    <div id="tab-state" class="tab-panel">${stateHtml}</div>
    <div id="tab-branches" class="tab-panel">${branchHtml}</div>
    <div id="tab-gates" class="tab-panel">${gateHtml}</div>
  </div>
  <script>
${REPORT_SCRIPT}  </script>
</body>
</html>`;
  }

  private renderMessage(
    message: AgentMessage,
    index: number,
    options: SessionReportExportOptions,
    labels: RuntimeSessionReportLabels
  ): string {
    if (message.role === 'user') {
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
      return `<div class="msg-card user"><div class="msg-header">${escapeHtml(labels.user)} #${index + 1}</div><div class="text-content">${escapeHtml(text)}</div></div>`;
    }
    if (message.role === 'assistant') {
      const parts = message.content
        .map((block) => {
          if (block.type === 'thinking' && options.includeThinking !== false) {
            return `<div class="thinking-box"><strong>${escapeHtml(labels.thinking)}</strong>\n${escapeHtml(block.thinking)}</div>`;
          }
          if (block.type === 'text') return `<div class="text-content">${escapeHtml(block.text)}</div>`;
          if (block.type === 'toolCall' && options.includeToolCalls !== false) {
            return `<div class="tool-call"><strong>${escapeHtml(labels.toolCall)}</strong>: <code>${escapeHtml(block.name)}</code>\n${escapeHtml(JSON.stringify(block.arguments, null, 2))}</div>`;
          }
          return '';
        })
        .filter(Boolean)
        .join('\n');
      return `<div class="msg-card assistant"><div class="msg-header">${escapeHtml(labels.assistant)} #${index + 1}</div>${parts}</div>`;
    }
    if (message.role === 'toolResult') {
      return `<div class="msg-card tool-result"><div class="msg-header">${escapeHtml(labels.toolResult)} #${index + 1}</div><pre class="tool-result-content">${escapeHtml(JSON.stringify(message.content, null, 2))}</pre></div>`;
    }
    if (message.role === 'system') {
      return `<div class="msg-card"><div class="msg-header">${escapeHtml(labels.system)} #${index + 1}</div><div class="text-content">${escapeHtml(message.content)}</div></div>`;
    }
    return `<div class="msg-card"><div class="msg-header">${escapeHtml(labels.custom)} #${index + 1}</div><pre class="tool-result-content">${escapeHtml(JSON.stringify(message.content, null, 2))}</pre></div>`;
  }

  private renderState(
    state: TState | undefined,
    adapter: RuntimeSessionReportStateAdapter<TState> | undefined,
    labels: RuntimeSessionReportLabels
  ): string {
    if (!state) return `<p class="empty-hint">${escapeHtml(labels.emptyState)}</p>`;
    const sections = adapter?.toSections(state) ?? [
      {
        title: labels.state,
        columns: ['Value'],
        rows: [[JSON.stringify(state, null, 2)]]
      }
    ];
    if (sections.length === 0) return `<p class="empty-hint">${escapeHtml(labels.emptyState)}</p>`;
    return `<div class="state-grid">${sections
      .map(
        (section) =>
          `<section><h2>${escapeHtml(section.title)}</h2><table class="data-table"><thead><tr>${section.columns
            .map((column) => `<th>${escapeHtml(column)}</th>`)
            .join('')}</tr></thead><tbody>${section.rows
            .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join('')}</tr>`)
            .join('')}</tbody></table></section>`
      )
      .join('')}</div>`;
  }

  private renderBranches(
    summaries: SessionReportBranchSummary[],
    branchCount: number,
    labels: RuntimeSessionReportLabels
  ): string {
    if (summaries.length === 0) {
      return `<p class="empty-hint">${escapeHtml(branchCount ? `${branchCount} ${labels.branches}` : labels.emptyBranches)}</p>`;
    }
    return summaries
      .map(
        (summary) =>
          `<article class="branch-card"><h3>${escapeHtml(labels.branch)}: ${escapeHtml(summary.branchName)}</h3><p>${escapeHtml(summary.summaryText)}</p>${summary.differenceCount === undefined ? '' : `<div>${escapeHtml(labels.differenceCount)}: ${summary.differenceCount}</div>`}</article>`
      )
      .join('');
  }

  private renderGates(issues: QualityGateIssue[], labels: RuntimeSessionReportLabels): string {
    if (issues.length === 0) return `<p class="empty-hint">${escapeHtml(labels.gatesPassed)}</p>`;
    return issues
      .map(
        (issue) =>
          `<article class="gate-card ${escapeHtml(issue.severity)}"><strong>${escapeHtml(issue.type)}</strong><div>${escapeHtml(issue.description)}</div></article>`
      )
      .join('');
  }

  private renderUsage(usage: UsageTotals | undefined, labels: RuntimeSessionReportLabels): string {
    if (!usage) return '';
    const metric = (value: string, label: string, highlight = false) =>
      `<div class="metric-card${highlight ? ' highlight' : ''}"><div class="metric-val">${escapeHtml(value)}</div><div class="metric-lbl">${escapeHtml(label)}</div></div>`;
    return `<div class="usage-dashboard">
      ${metric(usage.totalTokens.toLocaleString(), labels.totalTokens)}
      ${metric(usage.inputTokens.toLocaleString(), labels.inputTokens)}
      ${metric(usage.outputTokens.toLocaleString(), labels.outputTokens)}
      ${metric((usage.cacheReadTokens || 0).toLocaleString(), labels.cachedTokens)}
      ${metric(`$${(usage.costUsd || 0).toFixed(4)}`, labels.cost, true)}
    </div>`;
  }
}

/**
 * Legacy creative compatibility facade. Domain-shaped rendering is isolated
 * here and is never used by RuntimeSessionReportExporter itself.
 */
export class SessionReportExporter {
  private readonly runtime = new RuntimeSessionReportExporter<RuntimeState>();

  public exportToHtml(messages: AgentMessage[], options: SessionReportExportOptions = {}, tree?: SessionTree): string {
    const { ledger, labels, stateAdapter, ...runtimeOptions } = options;
    const resolvedLabels = { ...DEFAULT_LEGACY_LABELS, ...labels };
    const state = ledger ?? options.state;
    const adapter = ledger ? createLegacyStateAdapter(resolvedLabels) : stateAdapter;
    return this.runtime.exportToHtml(
      messages,
      {
        ...runtimeOptions,
        state,
        stateAdapter: adapter,
        labels: {
          ...resolvedLabels,
          state: resolvedLabels.ledger,
          emptyState: resolvedLabels.emptyLedger
        }
      },
      tree
    );
  }
}

function createLegacyStateAdapter(labels: SessionReportLabels): RuntimeSessionReportStateAdapter<StateLedger> {
  return {
    toSections: (ledger) => {
      const entities = ledger.entities || [];
      const assets = ledger.assets || [];
      const tracks = ledger.tracks || [];
      if (entities.length === 0 && assets.length === 0 && tracks.length === 0) return [];
      return [
        {
          title: `${labels.entities} (${entities.length})`,
          columns: ['Name', 'Status', 'Attributes'],
          rows: entities.map((entity) => [
            entity.name,
            entity.status || labels.active,
            JSON.stringify(entity.attributes || {})
          ])
        },
        {
          title: `${labels.assets} (${assets.length})`,
          columns: ['Name', 'Owner', 'State'],
          rows: assets.map((asset) => [
            asset.name,
            asset.holder || asset.owner || labels.unknown,
            asset.state || labels.active
          ])
        },
        {
          title: `${labels.tracks} (${tracks.length})`,
          columns: ['Track', 'Status'],
          rows: tracks.map((track) => [
            track.clue || track.summary || track.id || labels.unknown,
            track.status || labels.active
          ])
        }
      ];
    }
  };
}

function formatTimestamp(value: string | number | Date | undefined): string {
  if (value === undefined) return new Date().toISOString();
  return new Date(value).toISOString();
}
