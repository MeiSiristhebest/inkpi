import type { AgentMessage, ExportOptions } from '@inkpi/protocol';
import type { SessionTree } from '../tree.js';

export class SessionExporter {
  /**
   * 导出为单文件富交互 HTML 报告 (1:1 移植自 repos/pi packages/coding-agent/src/core/session-export.ts)
   */
  public exportToHtml(messages: AgentMessage[], options: ExportOptions = { format: 'html' }, tree?: SessionTree): string {
    const title = options.title || 'InkPi 创作推演与分支审阅报告';
    const branches = tree ? tree.getBranches() : [];

    const messagesHtml = messages
      .map((msg) => {
        let contentHtml = '';
        if (msg.role === 'user') {
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          contentHtml = `<div class="msg-box user"><div class="role-badge">作者指令</div><div class="content">${this.escapeHtml(text)}</div></div>`;
        } else if (msg.role === 'assistant') {
          const parts: string[] = [];
          for (const block of msg.content) {
            if (block.type === 'thinking' && options.includeThinking !== false) {
              parts.push(`<div class="thinking-box">💡 <strong>推演思考</strong>:\n${this.escapeHtml(block.thinking)}</div>`);
            } else if (block.type === 'text') {
              parts.push(`<div class="text-box">${this.escapeHtml(block.text)}</div>`);
            } else if (block.type === 'toolCall' && options.includeToolCalls !== false) {
              parts.push(`<div class="tool-box">🔧 调用工具: <code>${block.name}</code> (${JSON.stringify(block.arguments)})</div>`);
            }
          }
          contentHtml = `<div class="msg-box assistant"><div class="role-badge">AI 创作响应</div><div class="content">${parts.join('\n')}</div></div>`;
        } else if (msg.role === 'toolResult') {
          contentHtml = `<div class="msg-box tool-result"><div class="role-badge">工具回包</div><pre>${this.escapeHtml(JSON.stringify(msg.content, null, 2))}</pre></div>`;
        }
        return contentHtml;
      })
      .join('\n');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>${this.escapeHtml(title)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    .container { max-width: 900px; margin: 0 auto; }
    h1 { border-bottom: 2px solid #334155; padding-bottom: 12px; font-size: 24px; color: #38bdf8; }
    .msg-box { margin-bottom: 20px; padding: 16px; border-radius: 8px; border: 1px solid #334155; }
    .msg-box.user { background: #1e293b; border-left: 4px solid #38bdf8; }
    .msg-box.assistant { background: #1e293b; border-left: 4px solid #34d399; }
    .msg-box.tool-result { background: #0f172a; border-left: 4px solid #f59e0b; }
    .role-badge { font-weight: bold; font-size: 13px; margin-bottom: 8px; text-transform: uppercase; color: #94a3b8; }
    .thinking-box { background: #020617; border-left: 3px solid #818cf8; padding: 10px; margin-bottom: 10px; font-size: 13px; color: #cbd5e1; white-space: pre-wrap; }
    .text-box { line-height: 1.7; font-size: 15px; white-space: pre-wrap; }
    .tool-box { background: #020617; padding: 8px; font-size: 12px; color: #f59e0b; font-family: monospace; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${this.escapeHtml(title)}</h1>
    <div class="meta">分支总数: ${branches.length} | 消息数: ${messages.length}</div>
    <div class="messages">
      ${messagesHtml}
    </div>
  </div>
</body>
</html>`;
  }

  /**
   * 导出为 Markdown 文本
   */
  public exportToMarkdown(messages: AgentMessage[], options: ExportOptions = { format: 'markdown' }): string {
    const lines: string[] = [`# ${options.title || 'InkPi 创作推演报告'}\n`];

    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        lines.push(`## 👤 作者指令\n\n${text}\n`);
      } else if (msg.role === 'assistant') {
        lines.push(`## 🤖 AI 创作\n`);
        for (const block of msg.content) {
          if (block.type === 'thinking' && options.includeThinking !== false) {
            lines.push(`> 💡 **推演构思**:\n> ${block.thinking.replace(/\n/g, '\n> ')}\n`);
          } else if (block.type === 'text') {
            lines.push(`${block.text}\n`);
          }
        }
      }
    }

    return lines.join('\n');
  }

  /**
   * 导出为可重放、可断点恢复的标准 JSONL 会话流 (1:1 对标 repos/pi Session JSONL Codec)
   */
  public exportToJsonl(messages: AgentMessage[]): string {
    return messages.map((m) => JSON.stringify(m)).join('\n');
  }

  /**
   * 从 JSONL 文本导入并恢复会话消息队列
   */
  public importFromJsonl(jsonlContent: string): AgentMessage[] {
    const lines = jsonlContent.split('\n').map((l) => l.trim()).filter(Boolean);
    const messages: AgentMessage[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.role === 'string') {
          messages.push(parsed);
        }
      } catch {
        // Skip malformed line
      }
    }
    return messages;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}

