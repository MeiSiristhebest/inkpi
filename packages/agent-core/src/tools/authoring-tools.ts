import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTool } from '@inkpi/protocol';
import { generateImage } from '@inkpi/ai';
import { applyFuzzyTextEdit } from './edit-diff.js';
import { enforceOutputGuard } from './output-guard.js';

export interface AuthoringDocumentStore {
  read(documentId: string): Promise<string | null>;
  write(documentId: string, content: string): Promise<void>;
  list(): Promise<Array<{ documentId: string; title?: string; wordCount?: number }>>;
  searchMemory?(query: string, limit?: number): Promise<Array<{ documentId: string; title?: string; snippet: string }>>;
}

/**
 * 真实本地磁盘文档存储适配器 (面向 Desktop / 实际工程目录创作)
 * 安全隔离在 baseDir 下，将 documentId 映射为真实的 Markdown/文本章节文件。
 */
export class FileSystemDocumentStore implements AuthoringDocumentStore {
  private baseDir: string;

  constructor(baseDir: string = process.cwd()) {
    this.baseDir = path.resolve(baseDir);
    if (!fs.existsSync(this.baseDir)) {
      fs.mkdirSync(this.baseDir, { recursive: true });
    }
  }

  private resolveDocPath(documentId: string): string {
    const safeName = documentId.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
    const fileName = safeName.endsWith('.md') || safeName.endsWith('.txt') ? safeName : `${safeName}.md`;
    return path.join(this.baseDir, fileName);
  }

  public async read(documentId: string): Promise<string | null> {
    const filePath = this.resolveDocPath(documentId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.readFileSync(filePath, 'utf8');
  }

  public async write(documentId: string, content: string): Promise<void> {
    const filePath = this.resolveDocPath(documentId);
    fs.writeFileSync(filePath, content, 'utf8');
  }

  public async list(): Promise<Array<{ documentId: string; title?: string; wordCount?: number }>> {
    if (!fs.existsSync(this.baseDir)) return [];
    const entries = fs.readdirSync(this.baseDir, { withFileTypes: true });
    const results: Array<{ documentId: string; title?: string; wordCount?: number }> = [];

    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith('.md') || entry.name.endsWith('.txt'))) {
        const filePath = path.join(this.baseDir, entry.name);
        try {
          const content = fs.readFileSync(filePath, 'utf8');
          const docId = entry.name.replace(/\.(md|txt)$/, '');
          results.push({
            documentId: docId,
            title: docId,
            wordCount: content.length
          });
        } catch {
          // 忽略无权限或已锁定文件
        }
      }
    }
    return results;
  }

  public async searchMemory(
    query: string,
    limit = 10
  ): Promise<Array<{ documentId: string; title?: string; snippet: string }>> {
    const items = await this.list();
    const q = query.toLowerCase();
    const matches: Array<{ documentId: string; title?: string; snippet: string }> = [];

    for (const item of items) {
      const content = await this.read(item.documentId);
      if (!content) continue;
      const idx = content.toLowerCase().indexOf(q);
      if (idx !== -1) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(content.length, idx + q.length + 40);
        matches.push({
          documentId: item.documentId,
          title: item.title,
          snippet: `...${content.slice(start, end)}...`
        });
        if (matches.length >= limit) break;
      }
    }
    return matches;
  }
}

/**
 * 内存/工作区文档存储适配器（默认单机轻量实现，无任何外部硬编码）
 */
export class InMemoryDocumentStore implements AuthoringDocumentStore {
  private docs = new Map<string, string>();

  public async read(documentId: string): Promise<string | null> {
    return this.docs.get(documentId) ?? null;
  }

  public async write(documentId: string, content: string): Promise<void> {
    this.docs.set(documentId, content);
  }

  public async list(): Promise<Array<{ documentId: string; title?: string; wordCount?: number }>> {
    const list: Array<{ documentId: string; title?: string; wordCount?: number }> = [];
    for (const [id, text] of this.docs.entries()) {
      list.push({
        documentId: id,
        title: id,
        wordCount: text.length
      });
    }
    return list;
  }

  public async searchMemory(
    query: string,
    limit = 10
  ): Promise<Array<{ documentId: string; title?: string; snippet: string }>> {
    const q = query.toLowerCase();
    const results: Array<{ documentId: string; title?: string; snippet: string }> = [];
    for (const [id, text] of this.docs.entries()) {
      const idx = text.toLowerCase().indexOf(q);
      if (idx !== -1) {
        const start = Math.max(0, idx - 40);
        const end = Math.min(text.length, idx + q.length + 40);
        results.push({
          documentId: id,
          title: id,
          snippet: `...${text.slice(start, end)}...`
        });
        if (results.length >= limit) break;
      }
    }
    return results;
  }
}

/**
 * 创建全套原生创作工具集（Native Authoring Toolset）
 */
export function createAuthoringTools(docStore: AuthoringDocumentStore = new InMemoryDocumentStore()): AgentTool[] {
  // 1. 阅读/拉取章节
  const readChapterTool: AgentTool = {
    name: 'read_chapter',
    description: '读取指定章节或文档正文内容。支持根据起始行或字符限制进行分页阅读。',
    parameters: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: '章节或文档唯一标识符，如 "chapter-1" 或 "outline"'
        },
        startLine: {
          type: 'number',
          description: '起始行号（从 1 开始计）'
        },
        maxLines: {
          type: 'number',
          description: '最大读取行数，默认读取全文'
        }
      },
      required: ['documentId']
    },
    execute: async (_toolCallId, args) => {
      const docId = String(args.documentId);
      const content = await docStore.read(docId);
      if (content === null) {
        return {
          content: [{ type: 'text', text: `Document '${docId}' not found.` }],
          isError: true
        };
      }

      let textToReturn = content;
      if (typeof args.startLine === 'number' || typeof args.maxLines === 'number') {
        const lines = content.split('\n');
        const start = Math.max(0, (Number(args.startLine) || 1) - 1);
        const count = Number(args.maxLines) || lines.length;
        textToReturn = lines.slice(start, start + count).join('\n');
      }

      const guarded = enforceOutputGuard(textToReturn);
      return {
        content: [{ type: 'text', text: guarded.content }]
      };
    }
  };

  // 2. 局部微调/外科手术级修改（基于 Fuzzy Hunk Matching）
  const editTextTool: AgentTool = {
    name: 'edit_text',
    description:
      '带有模糊容错匹配的局部文本手术刀。用于精准替换章节中的特定段落、对话或词句，杜绝重写整章破坏其他内容。',
    parameters: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: '目标文档标识符'
        },
        oldText: {
          type: 'string',
          description: '待替换的原始文本段落（支持微小标点或空格容错）'
        },
        newText: {
          type: 'string',
          description: '替换后的新文本内容'
        },
        hintLineNumber: {
          type: 'number',
          description: '大致所在行号（可选，提供提示以加速定位）'
        }
      },
      required: ['documentId', 'oldText', 'newText']
    },
    execute: async (_toolCallId, args) => {
      const docId = String(args.documentId);
      const current = await docStore.read(docId);
      if (current === null) {
        return {
          content: [{ type: 'text', text: `Document '${docId}' does not exist.` }],
          isError: true
        };
      }

      const result = applyFuzzyTextEdit(
        current,
        {
          oldText: String(args.oldText),
          newText: String(args.newText)
        }
      );

      if (!result.success) {
        return {
          content: [{ type: 'text', text: `Edit failed: ${result.error}` }],
          isError: true
        };
      }

      await docStore.write(docId, result.newContent);
      return {
        content: [{ type: 'text', text: `Successfully updated '${docId}'.` }]
      };
    }
  };

  // 3. 章节草稿创建与追加
  const writeDraftTool: AgentTool = {
    name: 'write_draft',
    description: '创建新章节或在章节末尾追加内容。当 mode 为 append 时，安全追加在尾部。',
    parameters: {
      type: 'object',
      properties: {
        documentId: {
          type: 'string',
          description: '文档或章节标识符'
        },
        content: {
          type: 'string',
          description: '正文草稿内容'
        },
        mode: {
          type: 'string',
          enum: ['create', 'overwrite', 'append'],
          description: '写入模式：create (仅不存在时创建), overwrite (全量覆写), append (末尾追加)'
        }
      },
      required: ['documentId', 'content']
    },
    execute: async (_toolCallId, args) => {
      const docId = String(args.documentId);
      const text = String(args.content);
      const mode = (args.mode as string) || 'create';

      const existing = await docStore.read(docId);

      if (mode === 'create' && existing !== null) {
        return {
          content: [{ type: 'text', text: `Document '${docId}' already exists. Use mode 'overwrite' or 'append'.` }],
          isError: true
        };
      }

      let finalContent = text;
      if (mode === 'append' && existing !== null) {
        finalContent = `${existing.trimEnd()}\n\n${text}`;
      }

      await docStore.write(docId, finalContent);
      return {
        content: [{ type: 'text', text: `Successfully wrote '${docId}' (${finalContent.length} chars).` }]
      };
    }
  };

  // 4. 全书目录大纲浏览与字数统计
  const listOutlineTool: AgentTool = {
    name: 'list_story_outline',
    description: '列出作品所有章节与大纲文档列表，包含每个文档的字符/字数统计。',
    parameters: {
      type: 'object',
      properties: {}
    },
    execute: async () => {
      const items = await docStore.list();
      if (items.length === 0) {
        return {
          content: [{ type: 'text', text: 'Story workspace is currently empty (0 documents).' }]
        };
      }

      const lines = ['Story Documents & Chapters:'];
      let totalWords = 0;
      for (const item of items) {
        const words = item.wordCount ?? 0;
        totalWords += words;
        lines.push(`- [${item.documentId}] ${item.title || item.documentId} (~${words} chars)`);
      }
      lines.push(`Total Characters: ${totalWords}`);

      return {
        content: [{ type: 'text', text: lines.join('\n') }]
      };
    }
  };

  // 5. 人设与伏笔全局记忆雷达（语义/FTS检索）
  const searchStoryMemoryTool: AgentTool = {
    name: 'search_story_memory',
    description: '人设、情节与伏笔全局检索雷达。在大模型推演剧情时，快速检索历史章节相关设定片段，防止吃书和逻辑冲突。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '检索关键词，如 "林远 佩剑" 或 "九转金丹 伏笔"'
        },
        limit: {
          type: 'number',
          description: '最大返回条目数，默认 5'
        }
      },
      required: ['query']
    },
    execute: async (_toolCallId, args) => {
      const query = String(args.query);
      const limit = Number(args.limit) || 5;

      if (!docStore.searchMemory) {
        return {
          content: [{ type: 'text', text: 'Memory search capability is not enabled on this store.' }],
          isError: true
        };
      }

      const matches = await docStore.searchMemory(query, limit);
      if (matches.length === 0) {
        return {
          content: [{ type: 'text', text: `No relevant story memory found for query: "${query}".` }]
        };
      }

      const textBlocks = matches.map((m, idx) => `[Match ${idx + 1}] (${m.documentId})\n${m.snippet}`);

      return {
        content: [{ type: 'text', text: textBlocks.join('\n\n') }]
      };
    }
  };

  // 6. 书籍封面与插画生成
  const generateCoverTool: AgentTool = {
    name: 'generate_book_cover',
    description: '根据剧情、大纲或角色描述生成专属小说封面或插图。调用真实底层画图引擎生成高清图像。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '图像生成提示词，如 "中国风古典小说封面，青山绿水，孤舟蓑笠翁"'
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '1024x1792', '1792x1024'],
          description: '封面比例尺寸，默认 "1024x1792" (标准竖版书封面)'
        },
        style: {
          type: 'string',
          enum: ['natural', 'vivid'],
          description: '艺术风格设定'
        }
      },
      required: ['prompt']
    },
    execute: async (_toolCallId, args) => {
      try {
        const result = await generateImage({
          prompt: String(args.prompt),
          size: (args.size as string) || '1024x1792',
          style: (args.style as 'natural' | 'vivid') || 'natural'
        });

        const urls = result.data.map((d) => d.url).filter(Boolean);
        return {
          content: [
            {
              type: 'text',
              text: `Image generated successfully!\nURL: ${urls.join('\n')}`
            }
          ]
        };
      } catch (err: any) {
        return {
          content: [{ type: 'text', text: `Failed to generate image: ${err?.message || String(err)}` }],
          isError: true
        };
      }
    }
  };

  return [readChapterTool, editTextTool, writeDraftTool, listOutlineTool, searchStoryMemoryTool, generateCoverTool];
}
