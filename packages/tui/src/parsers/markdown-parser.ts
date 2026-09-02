/**
 * Pure Markdown block parser — no ANSI, no terminal coupling.
 *
 * Splits raw Markdown into a flat list of {@link MarkdownBlock}s. The ANSI
 * renderer (`components/markdown.ts`) consumes this AST, so the parsing logic
 * is unit-testable in isolation from any terminal output.
 */

export type MarkdownBlockType =
  | 'fence'
  | 'code'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'quote'
  | 'list'
  | 'text';

export interface MarkdownBlock {
  type: MarkdownBlockType;
  text: string;
}

export function parseMarkdown(rawText: string): MarkdownBlock[] {
  const rawLines = rawText.split('\n');
  const blocks: MarkdownBlock[] = [];
  let inCodeBlock = false;

  for (const line of rawLines) {
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      blocks.push({ type: 'fence', text: '' });
      continue;
    }

    if (inCodeBlock) {
      blocks.push({ type: 'code', text: line });
      continue;
    }

    if (line.startsWith('# ')) {
      blocks.push({ type: 'h1', text: line.slice(2) });
    } else if (line.startsWith('## ')) {
      blocks.push({ type: 'h2', text: line.slice(3) });
    } else if (line.startsWith('### ')) {
      blocks.push({ type: 'h3', text: line.slice(4) });
    } else if (line.startsWith('> ')) {
      blocks.push({ type: 'quote', text: line.slice(2) });
    } else if (line.startsWith('- ') || line.startsWith('* ')) {
      blocks.push({ type: 'list', text: line.slice(2) });
    } else {
      blocks.push({ type: 'text', text: line });
    }
  }

  return blocks;
}
