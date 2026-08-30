/**
 * 可视化故事演进档案与交互式 HTML 导出引擎 (Interactive Storyboard HTML Exporter)
 * 1:1 落地 Pi 的 export-html 与生态分享机制
 * 输出 100% 离线自包含、零外部依赖的单文件交互式故事档案（涵盖大纲正文、What-If 平行世界 DAG、状态账本、质量门禁与 Token 成本仪表盘）
 */

import type { AgentMessage, ExportOptions, StateLedger, UsageTotals, QualityGateIssue } from '@inkpi/protocol';
import type { SessionTree } from '../tree.js';
import type { UsageCostBreakdown } from '@inkpi/ai';

export interface StoryboardExportOptions extends Partial<ExportOptions> {
  title?: string;
  author?: string;
  summary?: string;
  ledger?: StateLedger;
  gateIssues?: QualityGateIssue[];
  usageTotals?: UsageTotals;
  costBreakdown?: UsageCostBreakdown;
  whatIfSummaries?: Array<{ branchName: string; summaryText: string; entityDiffCount: number }>;
}

export class StoryboardExporter {
  public static exportToStoryboardHtml(
    messages: AgentMessage[],
    options: StoryboardExportOptions = {},
    tree?: SessionTree
  ): string {

    const title = options.title || 'InkPi 交互式故事演进与平行世界推演档案';
    const author = options.author || 'InkPi Creator';
    const branches = tree ? tree.getBranches() : [];
    const ledger = options.ledger;
    const gateIssues = options.gateIssues || [];
    const usage = options.usageTotals;
    const cost = options.costBreakdown;
    const whatIfList = options.whatIfSummaries || [];

    // Render Messages Stream
    const messagesHtml = messages
      .map((msg, idx) => {
        if (msg.role === 'user') {
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          return `<div class="msg-card user">
            <div class="msg-header"><span class="badge user">👤 作者指令 #${idx + 1}</span></div>
            <div class="msg-body">${escapeHtml(text)}</div>
          </div>`;
        }
        if (msg.role === 'assistant') {
          const parts: string[] = [];
          for (const block of msg.content) {
            if (block.type === 'thinking' && options.includeThinking !== false) {
              parts.push(`<details class="thinking-accordion" open>
                <summary>💡 <strong>深度推演思考过程</strong> (~${block.thinking.length} 字符)</summary>
                <div class="thinking-content">${escapeHtml(block.thinking)}</div>
              </details>`);
            } else if (block.type === 'text') {
              parts.push(`<div class="text-content">${escapeHtml(block.text)}</div>`);
            } else if (block.type === 'toolCall' && options.includeToolCalls !== false) {
              parts.push(`<div class="tool-call">🔧 <strong>调用工具:</strong> <code>${escapeHtml(block.name)}</code> <pre>${escapeHtml(JSON.stringify(block.arguments, null, 2))}</pre></div>`);
            }
          }
          return `<div class="msg-card assistant">
            <div class="msg-header"><span class="badge assistant">🤖 AI 创作响应 #${idx + 1}</span></div>
            <div class="msg-body">${parts.join('\n')}</div>
          </div>`;
        }
        if (msg.role === 'toolResult') {
          return `<div class="msg-card tool-result">
            <div class="msg-header"><span class="badge tool">⚙️ 工具执行回包 #${idx + 1}</span></div>
            <pre class="tool-result-content">${escapeHtml(JSON.stringify(msg.content, null, 2))}</pre>
          </div>`;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');

    // Render State Ledger Tab
    let ledgerHtml = '<p class="empty-hint">暂无提取的状态账本实体。</p>';
    if (ledger && (ledger.entities?.length || ledger.assets?.length || ledger.locations?.length)) {
      const entityRows = (ledger.entities || []).map((e) => `<tr><td><strong>${escapeHtml(e.name)}</strong></td><td><span class="status-tag status-${e.status}">${e.status}</span></td><td>${escapeHtml(JSON.stringify(e.attributes || {}))}</td></tr>`).join('');
      const assetRows = (ledger.assets || []).map((a) => `<tr><td><strong>${escapeHtml(a.name)}</strong></td><td>${escapeHtml(a.holder || '未知')}</td><td>${escapeHtml(a.state || '正常')}</td></tr>`).join('');
      
      ledgerHtml = `
        <div class="ledger-grid">
          <div class="ledger-section">
            <h3>👥 人物与关键角色 (${ledger.entities?.length || 0})</h3>
            <table class="data-table"><thead><tr><th>角色名</th><th>状态</th><th>设定属性</th></tr></thead><tbody>${entityRows}</tbody></table>
          </div>
          <div class="ledger-section">
            <h3>🗡️ 关键道具与资产 (${ledger.assets?.length || 0})</h3>
            <table class="data-table"><thead><tr><th>资产名</th><th>当前持有者</th><th>状态</th></tr></thead><tbody>${assetRows}</tbody></table>
          </div>
        </div>
      `;
    }

    // Render Quality Gate Issues
    let gateHtml = '<p class="empty-hint">✅ 质量门禁检测全部通过，未发现逻辑崩坏或设定矛盾。</p>';
    if (gateIssues.length > 0) {
      const issueRows = gateIssues.map((issue) => {
        const sev = String(issue.severity || (issue as any).level || 'warning');
        const name = String(issue.type || (issue as any).ruleName || 'GateIssue');
        const desc = String(issue.description || (issue as any).message || '');
        const snippet = (issue as any).snippet ? String((issue as any).snippet) : '';
        return `
        <div class="gate-issue-card level-${escapeHtml(sev)}">
          <div class="issue-header"><span class="issue-badge">${escapeHtml(sev.toUpperCase())}</span> <strong>${escapeHtml(name)}</strong></div>
          <div class="issue-msg">${escapeHtml(desc)}</div>
          ${snippet ? `<pre class="issue-snippet">${escapeHtml(snippet)}</pre>` : ''}
        </div>
      `;
      }).join('');
      gateHtml = `<div class="gate-issues-list">${issueRows}</div>`;
    }


    // Render What-If Parallel Branches
    let whatIfHtml = '<p class="empty-hint">暂无平行推演分支。</p>';
    if (whatIfList.length > 0 || branches.length > 0) {
      const whatIfCards = whatIfList.map((item) => `
        <div class="what-if-card">
          <h4>🌿 分支线: ${escapeHtml(item.branchName)}</h4>
          <p>${escapeHtml(item.summaryText)}</p>
          <div class="diff-badge">⚡ 影响状态节点数: ${item.entityDiffCount}</div>
        </div>
      `).join('');
      whatIfHtml = `<div class="what-if-list">${whatIfCards}</div>`;
    }

    // Render Usage & Cost Dashboard
    let usageHtml = '';
    if (usage) {
      usageHtml = `
        <div class="usage-dashboard">
          <div class="metric-card"><div class="metric-val">${usage.totalTokens.toLocaleString()}</div><div class="metric-lbl">总 Token 消耗</div></div>
          <div class="metric-card"><div class="metric-val">${usage.inputTokens.toLocaleString()}</div><div class="metric-lbl">输入 Prompt Tokens</div></div>
          <div class="metric-card"><div class="metric-val">${usage.outputTokens.toLocaleString()}</div><div class="metric-lbl">生成 Output Tokens</div></div>
          <div class="metric-card"><div class="metric-val">${(usage.cacheReadTokens || 0).toLocaleString()}</div><div class="metric-lbl">Prompt Cache 命中</div></div>
          <div class="metric-card highlight"><div class="metric-val">$${(usage.costUsd || 0).toFixed(4)}</div><div class="metric-lbl">总创作成本 (USD)</div></div>
        </div>
      `;
    }

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #131b2e;
      --border: #23314d;
      --text: #e2e8f0;
      --text-muted: #94a3b8;
      --accent: #38bdf8;
      --accent-green: #34d399;
      --accent-purple: #818cf8;
      --accent-amber: #f59e0b;
      --accent-red: #f87171;
    }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 24px; line-height: 1.6; }
    .container { max-width: 1100px; margin: 0 auto; }
    header { border-bottom: 2px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; display: flex; justify-content: space-between; align-items: flex-end; }
    h1 { margin: 0; font-size: 24px; color: var(--accent); }
    .author-tag { font-size: 14px; color: var(--text-muted); }
    
    /* Navigation Tabs */
    .tabs { display: flex; gap: 8px; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .tab-btn { background: none; border: 1px solid transparent; color: var(--text-muted); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; font-weight: 500; transition: all 0.2s; }
    .tab-btn:hover { color: var(--text); background: var(--card-bg); }
    .tab-btn.active { color: var(--accent); background: var(--card-bg); border-color: var(--border); }
    
    .tab-panel { display: none; }
    .tab-panel.active { display: block; animation: fadeIn 0.2s ease-in-out; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }

    /* Dashboard Metrics */
    .usage-dashboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .metric-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; text-align: center; }
    .metric-card.highlight { border-color: var(--accent-green); background: rgba(52, 211, 153, 0.05); }
    .metric-val { font-size: 22px; font-weight: bold; color: var(--text); margin-bottom: 4px; }
    .metric-card.highlight .metric-val { color: var(--accent-green); }
    .metric-lbl { font-size: 12px; color: var(--text-muted); text-transform: uppercase; }

    /* Messages Stream */
    .msg-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .msg-card.user { border-left: 4px solid var(--accent); }
    .msg-card.assistant { border-left: 4px solid var(--accent-green); }
    .msg-card.tool-result { border-left: 4px solid var(--accent-amber); background: #0c1220; }
    .msg-header { margin-bottom: 12px; }
    .badge { font-size: 12px; font-weight: bold; padding: 2px 8px; border-radius: 4px; text-transform: uppercase; }
    .badge.user { background: rgba(56, 189, 248, 0.15); color: var(--accent); }
    .badge.assistant { background: rgba(52, 211, 153, 0.15); color: var(--accent-green); }
    .badge.tool { background: rgba(245, 158, 11, 0.15); color: var(--accent-amber); }
    .text-content { font-size: 15px; line-height: 1.7; white-space: pre-wrap; }
    .thinking-accordion { background: #070a12; border: 1px solid var(--border); border-radius: 6px; padding: 10px 14px; margin-bottom: 12px; font-size: 13px; }
    .thinking-accordion summary { cursor: pointer; color: var(--accent-purple); user-select: none; }
    .thinking-content { margin-top: 10px; color: #cbd5e1; white-space: pre-wrap; border-top: 1px dashed var(--border); padding-top: 8px; }
    .tool-call { background: #070a12; padding: 10px; border-radius: 6px; font-size: 12px; margin-top: 8px; font-family: monospace; color: var(--accent-amber); }
    .tool-result-content { font-family: monospace; font-size: 12px; color: #94a3b8; overflow-x: auto; }

    /* Ledger Table */
    .ledger-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 768px) { .ledger-grid { grid-template-columns: 1fr; } }
    .ledger-section h3 { font-size: 16px; margin-top: 0; color: var(--accent); border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .data-table th, .data-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
    .data-table th { color: var(--text-muted); background: #070a12; }
    .status-tag { padding: 2px 6px; border-radius: 4px; font-size: 11px; font-weight: bold; }
    .status-active { background: rgba(52, 211, 153, 0.2); color: var(--accent-green); }
    .status-dead { background: rgba(248, 113, 113, 0.2); color: var(--accent-red); }

    /* Gate Issues */
    .gate-issue-card { background: var(--card-bg); border-left: 4px solid var(--accent-amber); border-radius: 6px; padding: 12px; margin-bottom: 12px; }
    .gate-issue-card.level-error { border-left-color: var(--accent-red); }
    .gate-issue-card.level-warn { border-left-color: var(--accent-amber); }
    .issue-badge { font-size: 11px; font-weight: bold; padding: 2px 6px; border-radius: 4px; background: rgba(248, 113, 113, 0.15); color: var(--accent-red); }
    .issue-snippet { background: #070a12; padding: 8px; font-size: 12px; border-radius: 4px; margin-top: 8px; color: #94a3b8; }

    /* What-If Cards */
    .what-if-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
    .what-if-card h4 { margin: 0 0 8px 0; color: var(--accent); }
    .diff-badge { font-size: 12px; color: var(--accent-amber); font-weight: bold; }
    .empty-hint { color: var(--text-muted); font-style: italic; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1>${escapeHtml(title)}</h1>
        <div class="author-tag">创作者: ${escapeHtml(author)} | 导出时间: ${new Date().toLocaleString()}</div>
      </div>
    </header>

    ${usageHtml}

    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('stream')">📜 创作演进时间轴</button>
      <button class="tab-btn" onclick="switchTab('ledger')">📊 实体状态账本</button>
      <button class="tab-btn" onclick="switchTab('whatif')">🌿 What-If 平行世界 (${whatIfList.length})</button>
      <button class="tab-btn" onclick="switchTab('gate')">🛡️ 质量门禁审计 (${gateIssues.length})</button>
    </div>

    <div id="tab-stream" class="tab-panel active">
      ${messagesHtml}
    </div>

    <div id="tab-ledger" class="tab-panel">
      ${ledgerHtml}
    </div>

    <div id="tab-whatif" class="tab-panel">
      ${whatIfHtml}
    </div>

    <div id="tab-gate" class="tab-panel">
      ${gateHtml}
    </div>
  </div>

  <script>
    function switchTab(name) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      event.target.classList.add('active');
      const target = document.getElementById('tab-' + name);
      if (target) target.classList.add('active');
    }
  </script>
</body>
</html>`;
  }
}

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
