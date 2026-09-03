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

export const SESSION_EXPORT_STYLE = `    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { border-bottom: 2px solid #334155; padding-bottom: 12px; font-size: 24px; color: #38bdf8; }
    .msg-box { margin-bottom: 20px; padding: 16px; border-radius: 8px; border: 1px solid #334155; }
    .msg-box.user { background: #1e293b; border-left: 4px solid #38bdf8; }
    .msg-box.assistant { background: #1e293b; border-left: 4px solid #34d399; }
    .msg-box.tool-result { background: #0f172a; border-left: 4px solid #f59e0b; }
    .role-badge { font-weight: bold; font-size: 13px; margin-bottom: 8px; text-transform: uppercase; color: #94a3b8; }
    .thinking-box { background: #020617; border-left: 3px solid #818cf8; padding: 10px; margin-bottom: 10px; font-size: 13px; color: #cbd5e1; white-space: pre-wrap; }
    .text-box { line-height: 1.7; font-size: 15px; white-space: pre-wrap; }
    .tool-box { background: #020617; padding: 8px; font-size: 12px; color: #f59e0b; font-family: monospace; }`;

export const SESSION_SHARE_STYLE = `    :root { --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --accent: #38bdf8; --border: #334155; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: var(--bg); color: var(--text); padding: 2rem; margin: 0; line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; }
    header { border-bottom: 1px solid var(--border); padding-bottom: 1.5rem; margin-bottom: 2rem; }
    h1 { margin: 0 0 0.5rem; color: var(--accent); }
    .meta-bar { display: flex; gap: 1rem; color: #94a3b8; font-size: 0.9rem; flex-wrap: wrap; }
    .tag { background: #0369a1; color: white; padding: 2px 8px; border-radius: 4px; font-size: 0.8rem; }
    .message-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; margin-bottom: 1.5rem; padding: 1.2rem; }
    .message-card.user { border-left: 4px solid var(--accent); }
    .message-card.assistant { border-left: 4px solid #10b981; }
    .role-badge { font-weight: bold; font-size: 0.9rem; color: var(--accent); }
    .msg-thinking { background: #090d16; border-left: 3px solid #eab308; padding: 0.8rem; border-radius: 4px; margin: 0.8rem 0; font-size: 0.9rem; color: #cbd5e1; }
    .badge { font-weight: bold; }
    pre { white-space: pre-wrap; word-break: break-all; margin: 0.4rem 0 0; }`;
