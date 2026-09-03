import * as crypto from 'node:crypto';
import type { AgentMessage, StateLedger } from '@inkpi/protocol';
import type { SessionTree } from '../tree.js';
import { escapeHtml } from './html.js';
import { SESSION_SHARE_STYLE } from './report-assets.js';

export interface CreativeSessionShareOptions {
  title?: string;
  author?: string;
  category?: string;
  tags?: string[];
  sanitizeApiKeys?: boolean;
  sanitizeLocalPaths?: boolean;
  includeThinking?: boolean;
  includeToolCalls?: boolean;
  includeStateLedger?: boolean;
  includeSessionTree?: boolean;
  customRedactPatterns?: RegExp[];
}

export interface CreativeDatasetPayload {
  version: '1.0';
  id: string;
  title: string;
  author: string;
  category: string;
  tags: string[];
  createdAt: number;
  exportedAt: number;
  stats: {
    turnsCount: number;
    totalMessages: number;
    branchesCount: number;
    entitiesCount: number;
  };
  systemPrompt: string;
  stateLedger?: StateLedger;
  branches?: Array<{ leafId: string; length: number; lastMessage: AgentMessage }>;
  messages: AgentMessage[];
}

const DEFAULT_API_KEY_REGEX = /\b(sk-[a-zA-Z0-9_-]{20,}|Bearer\s+[a-zA-Z0-9_\-\.]{20,}|key-[a-zA-Z0-9]{16,})\b/gi;
const DEFAULT_PATH_REGEX = /([A-Za-z]:\\[\w\s\.\-\\]+|\/(?:home|Users|var|tmp|etc)\/[\w\s\.\-\/]+)/g;

/**
 * 会话脱敏与导出分享引擎
 * 支持将多轮 Agent 交互轨迹、会话树推演与状态流变安全导出为 Hugging Face / Gist 规范的数据集与独立 HTML
 */
export const SessionShareExporter = {
  /**
   * 脱敏文本内容（移除 API Key、敏感绝对路径与凭据）
   */
  sanitize(text: string, options: CreativeSessionShareOptions = {}): string {
    if (!text || typeof text !== 'string') return text;
    let sanitized = text;

    if (options.sanitizeApiKeys !== false) {
      sanitized = sanitized.replace(DEFAULT_API_KEY_REGEX, '[REDACTED_API_KEY]');
    }

    if (options.sanitizeLocalPaths !== false) {
      sanitized = sanitized.replace(DEFAULT_PATH_REGEX, '[REDACTED_LOCAL_PATH]');
    }

    if (options.customRedactPatterns) {
      for (const pattern of options.customRedactPatterns) {
        sanitized = sanitized.replace(pattern, '[REDACTED]');
      }
    }

    return sanitized;
  },

  /**
   * 对单条消息进行脱敏
   */
  sanitizeMessage(msg: AgentMessage, options: CreativeSessionShareOptions = {}): AgentMessage {
    let cloned: AgentMessage;
    try {
      cloned = JSON.parse(JSON.stringify(msg)) as AgentMessage;
    } catch {
      return { ...msg };
    }

    if (typeof cloned.content === 'string') {
      cloned.content = SessionShareExporter.sanitize(cloned.content, options);
    } else if (Array.isArray(cloned.content)) {
      cloned.content = cloned.content.map((block) => {
        if (block.type === 'text') {
          return { ...block, text: SessionShareExporter.sanitize(block.text, options) };
        }
        if (block.type === 'thinking') {
          return { ...block, thinking: SessionShareExporter.sanitize(block.thinking, options) };
        }
        if (block.type === 'toolCall') {
          let sanitizedArgs = block.arguments;
          try {
            sanitizedArgs = JSON.parse(SessionShareExporter.sanitize(JSON.stringify(block.arguments), options));
          } catch {
            // retain original arguments on serialization failure
          }
          return { ...block, arguments: sanitizedArgs };
        }
        return block;
      });
    }
    return cloned;
  },

  /**
   * 导出为结构化规范数据集 Payload (可直接上传 Hugging Face Datasets 或生成 JSONL)
   */
  exportDataset(
    source: {
      messages: AgentMessage[];
      tree?: SessionTree;
      stateLedger?: StateLedger;
      systemPrompt?: string;
    },
    options: CreativeSessionShareOptions = {}
  ): CreativeDatasetPayload {
    const rawMessages = source.messages || [];
    // 纯函数管道：sanitizeMessage 已深拷贝；此处仅用 map 产出新数组，
    // 绝不修改输入消息。旧实现误用 filter(回调内改 m.content 且恒返 true)，
    // 是把"过滤内容块"写成了"副作用 + 恒真谓词"的坏味道。
    const filteredMessages = rawMessages.map((m) => {
      const sanitized = SessionShareExporter.sanitizeMessage(m, options);
      if (sanitized.role !== 'assistant' || !Array.isArray(sanitized.content)) {
        return sanitized;
      }
      let content = sanitized.content;
      if (options.includeThinking === false) {
        content = content.filter((b) => b.type !== 'thinking');
      }
      if (options.includeToolCalls === false) {
        content = content.filter((b) => b.type !== 'toolCall');
      }
      // sanitizeMessage 返回全新对象，改 content 不影响原始消息
      return { ...sanitized, content };
    });

    const branches = source.tree ? source.tree.getBranches() : [];
    const entitiesCount = source.stateLedger?.entities?.length || 0;

    return {
      version: '1.0',
      id: `share_${crypto.randomUUID().slice(0, 10)}`,
      title: options.title || 'Creative Session Share',
      author: options.author || 'Anonymous Creator',
      category: options.category || 'creative-writing',
      tags: options.tags || ['agentic-writing', 'inkpi'],
      createdAt: Date.now(),
      exportedAt: Date.now(),
      stats: {
        turnsCount: filteredMessages.filter((m) => m.role === 'user').length,
        totalMessages: filteredMessages.length,
        branchesCount: branches.length,
        entitiesCount
      },
      systemPrompt: SessionShareExporter.sanitize(source.systemPrompt || '', options),
      stateLedger: options.includeStateLedger !== false ? source.stateLedger : undefined,
      branches: options.includeSessionTree !== false ? branches : undefined,
      messages: filteredMessages
    };
  },

  /**
   * 生成可直接独立托管的富交互分享 HTML
   */
  exportShareHtml(dataset: CreativeDatasetPayload): string {
    const messagesHtml = dataset.messages
      .map((msg) => {
        const isUser = msg.role === 'user';
        const roleLabel = isUser ? 'Creator' : 'InkPi Co-Writer';
        let body = '';
        if (typeof msg.content === 'string') {
          body = `<div class="msg-text">${escapeHtml(msg.content)}</div>`;
        } else if (Array.isArray(msg.content)) {
          body = msg.content
            .map((b) => {
              if (b.type === 'thinking') {
                return `<div class="msg-thinking"><span class="badge">💡 Thinking</span><pre>${escapeHtml(b.thinking)}</pre></div>`;
              }
              if (b.type === 'text') {
                return `<div class="msg-text">${escapeHtml(b.text)}</div>`;
              }
              if (b.type === 'toolCall') {
                return `<div class="msg-tool"><span class="badge">🔧 Tool</span> <code>${escapeHtml(b.name)}</code></div>`;
              }
              return '';
            })
            .join('');
        }
        return `
        <div class="message-card ${isUser ? 'user' : 'assistant'}">
          <div class="message-header">
            <span class="role-badge">${roleLabel}</span>
          </div>
          <div class="message-body">${body}</div>
        </div>`;
      })
      .join('\n');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(dataset.title)} - InkPi Creative Share</title>
  <style>
${SESSION_SHARE_STYLE}
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>${escapeHtml(dataset.title)}</h1>
      <div class="meta-bar">
        <span>👤 Author: ${escapeHtml(dataset.author)}</span>
        <span>🏷️ ${dataset.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</span>
        <span>📊 ${dataset.stats.turnsCount} Turns | ${dataset.stats.totalMessages} Messages</span>
      </div>
    </header>
    <main>
      ${messagesHtml}
    </main>
  </div>
</body>
</html>`;
  }
};
