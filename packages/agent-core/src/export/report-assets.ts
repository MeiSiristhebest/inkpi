/**
 * Session 报告 HTML 的静态资源（样式与脚本），从导出逻辑中抽出，
 * 避免 `SessionReportExporter` 内嵌大段 `<style>` / `<script>`（评审 §2 清理项）。
 * 这些字符串为纯静态内容，不含插值，可直接嵌入报告模板。
 */

export const REPORT_STYLE = `    :root { --bg: #0b0f19; --card-bg: #131b2e; --border: #23314d; --text: #e2e8f0; --text-muted: #94a3b8; --accent: #38bdf8; --accent-green: #34d399; --accent-purple: #818cf8; --accent-amber: #f59e0b; --accent-red: #f87171; }
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 24px; line-height: 1.6; }
    .container { max-width: 1100px; margin: 0 auto; }
    header { border-bottom: 2px solid var(--border); padding-bottom: 16px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 24px; color: var(--accent); }
    .meta { font-size: 14px; color: var(--text-muted); }
    .tabs { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .tab-btn { background: none; border: 1px solid transparent; color: var(--text-muted); padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .tab-btn:hover, .tab-btn.active { color: var(--accent); background: var(--card-bg); border-color: var(--border); }
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }
    .usage-dashboard { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .metric-card, .msg-card, .branch-card, .gate-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 8px; }
    .metric-card { padding: 16px; text-align: center; }
    .metric-card.highlight { border-color: var(--accent-green); }
    .metric-val { font-size: 22px; font-weight: bold; }
    .metric-lbl { font-size: 12px; color: var(--text-muted); }
    .msg-card { padding: 16px; margin-bottom: 16px; }
    .msg-card.user { border-left: 4px solid var(--accent); }
    .msg-card.assistant { border-left: 4px solid var(--accent-green); }
    .msg-card.tool-result { border-left: 4px solid var(--accent-amber); }
    .msg-header { margin-bottom: 12px; color: var(--text-muted); font-size: 12px; font-weight: bold; }
    .text-content { white-space: pre-wrap; }
    .thinking-box, .tool-call, .tool-result-content, .issue-snippet { background: #070a12; padding: 10px; border-radius: 6px; margin-top: 8px; white-space: pre-wrap; overflow-x: auto; }
    .thinking-box { color: #cbd5e1; }
    .tool-call { color: var(--accent-amber); }
    .ledger-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 20px; }
    .data-table { width: 100%; border-collapse: collapse; font-size: 13px; }
    .data-table th, .data-table td { padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
    .data-table th { color: var(--text-muted); }
    .branch-card, .gate-card { padding: 16px; margin-bottom: 16px; }
    .branch-card h3 { margin: 0 0 8px; color: var(--accent); }
    .gate-card { border-left: 4px solid var(--accent-amber); }
    .gate-card.critical { border-left-color: var(--accent-red); }
    .empty-hint { color: var(--text-muted); font-style: italic; }`;

export const REPORT_SCRIPT = `    function switchTab(event, name) {
      document.querySelectorAll('.tab-btn').forEach((button) => button.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((panel) => panel.classList.remove('active'));
      event.currentTarget.classList.add('active');
      const target = document.getElementById('tab-' + name);
      if (target) target.classList.add('active');
    }`;
