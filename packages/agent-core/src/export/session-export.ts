import { type AgentMessage, AgentMessageSchema, type ExportOptions, assertValid } from '@inkpi/protocol';
import type { SessionTree } from '../tree.js';
import { escapeHtml } from './html.js';
import { SESSION_EXPORT_STYLE } from './report-assets.js';

export interface MessageJsonlImportOptions {
  strict?: boolean;
  onError?: (error: Error, lineNumber: number, line: string) => void;
}

const DEFAULT_LABELS = {
  user: 'User',
  assistant: 'Assistant',
  thinking: 'Thinking',
  toolCall: 'Tool Call',
  toolResult: 'Tool Result',
  system: 'System',
  custom: 'Custom',
  branches: 'Branches',
  messages: 'Messages'
} as const;

export class SessionExporter {
  /**
   * 导出为单文件富交互 HTML 报告 (1:1 移植自 repos/pi packages/coding-agent/src/core/session-export.ts)
   */
  public exportToHtml(
    messages: AgentMessage[],
    options: ExportOptions = { format: 'html' },
    tree?: SessionTree
  ): string {
    const title = options.title || 'Session Export';
    const labels = { ...DEFAULT_LABELS, ...options.labels };
    const branches = tree ? tree.getBranches() : [];

    const messagesHtml = messages
      .map((msg) => {
        let contentHtml = '';
        if (msg.role === 'user') {
          const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          contentHtml = `<div class="msg-box user"><div class="role-badge">${this.escapeHtml(labels.user)}</div><div class="content">${this.escapeHtml(text)}</div></div>`;
        } else if (msg.role === 'assistant') {
          const parts: string[] = [];
          for (const block of msg.content) {
            if (block.type === 'thinking' && options.includeThinking !== false) {
              parts.push(
                `<div class="thinking-box">💡 <strong>${this.escapeHtml(labels.thinking)}</strong>:\n${this.escapeHtml(block.thinking)}</div>`
              );
            } else if (block.type === 'text') {
              parts.push(`<div class="text-box">${this.escapeHtml(block.text)}</div>`);
            } else if (block.type === 'toolCall' && options.includeToolCalls !== false) {
              parts.push(
                `<div class="tool-box">🔧 ${this.escapeHtml(labels.toolCall)}: <code>${this.escapeHtml(block.name)}</code> (${this.escapeHtml(JSON.stringify(block.arguments))})</div>`
              );
            }
          }
          contentHtml = `<div class="msg-box assistant"><div class="role-badge">${this.escapeHtml(labels.assistant)}</div><div class="content">${parts.join('\n')}</div></div>`;
        } else if (msg.role === 'toolResult') {
          contentHtml = `<div class="msg-box tool-result"><div class="role-badge">${this.escapeHtml(labels.toolResult)}</div><pre>${this.escapeHtml(JSON.stringify(msg.content, null, 2))}</pre></div>`;
        } else if (msg.role === 'system') {
          contentHtml = `<div class="msg-box system"><div class="role-badge">${this.escapeHtml(labels.system)}</div><div class="content">${this.escapeHtml(msg.content)}</div></div>`;
        } else if (msg.role === 'custom') {
          contentHtml = `<div class="msg-box custom"><div class="role-badge">${this.escapeHtml(labels.custom)}</div><pre>${this.escapeHtml(JSON.stringify(msg.content, null, 2))}</pre></div>`;
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
${SESSION_EXPORT_STYLE}
  </style>
</head>
<body>
  <div class="container">
    <h1>${this.escapeHtml(title)}</h1>
    <div class="meta">${this.escapeHtml(labels.branches)}: ${branches.length} | ${this.escapeHtml(labels.messages)}: ${messages.length}</div>
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
    const labels = { ...DEFAULT_LABELS, ...options.labels };
    const lines: string[] = [`# ${options.title || 'Session Export'}\n`];

    for (const msg of messages) {
      if (msg.role === 'user') {
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        lines.push(`## ${labels.user}\n\n${text}\n`);
      } else if (msg.role === 'assistant') {
        lines.push(`## ${labels.assistant}\n`);
        for (const block of msg.content) {
          if (block.type === 'thinking' && options.includeThinking !== false) {
            lines.push(`> 💡 **${labels.thinking}**:\n> ${block.thinking.replace(/\n/g, '\n> ')}\n`);
          } else if (block.type === 'text') {
            lines.push(`${block.text}\n`);
          }
        }
      } else if (msg.role === 'toolResult') {
        lines.push(`## ${labels.toolResult}\n\n${JSON.stringify(msg.content, null, 2)}\n`);
      } else if (msg.role === 'system') {
        lines.push(`## ${labels.system}\n\n${msg.content}\n`);
      } else if (msg.role === 'custom') {
        lines.push(`## ${labels.custom}\n\n${JSON.stringify(msg.content, null, 2)}\n`);
      }
    }

    return lines.join('\n');
  }

  /**
   * 导出为可重放、可断点恢复的标准 JSONL 会话流
   */
  public exportToJsonl(messages: AgentMessage[]): string {
    return messages.map((m) => JSON.stringify(m)).join('\n');
  }

  /**
   * 从 JSONL 文本导入并恢复会话消息队列
   */
  public importFromJsonl(jsonlContent: string, options: MessageJsonlImportOptions = {}): AgentMessage[] {
    const lines = jsonlContent.split('\n');
    const messages: AgentMessage[] = [];
    const strict = options.strict !== false;
    for (const [index, rawLine] of lines.entries()) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed: unknown = JSON.parse(line);
        assertValid(AgentMessageSchema, parsed, `Session message at line ${index + 1}`);
        messages.push(parsed as AgentMessage);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        options.onError?.(normalized, index + 1, rawLine);
        if (strict) {
          throw new Error(`Invalid session JSONL at line ${index + 1}: ${normalized.message}`, { cause: normalized });
        }
      }
    }
    return messages;
  }

  private escapeHtml(text: string): string {
    return escapeHtml(text);
  }
}
