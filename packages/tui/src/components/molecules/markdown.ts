/**
 * 终端 Markdown 渲染器
 *
 * Parsing is delegated to `../parsers/markdown-parser.js`; this component only
 * applies ANSI styling to the resulting block AST.
 */

import { Component, type RenderContext } from '../../layout.js';
import { ANSI } from '../../render.js';
import { parseMarkdown, type MarkdownBlock } from '../../parsers/markdown-parser.js';

export class Markdown extends Component {
  public rawText: string;

  constructor(rawText = '') {
    super();
    this.rawText = rawText;
  }

  public setText(text: string): void {
    this.rawText = text;
  }

  public formatMarkdown(_width: number): string[] {
    return renderMarkdownBlocks(parseMarkdown(this.rawText));
  }

  public render(context: RenderContext): string[] {
    return this.formatMarkdown(context.width).slice(0, context.height);
  }
}

/** Apply ANSI styling to a parsed Markdown block AST (pure, no I/O). */
export function renderMarkdownBlocks(blocks: MarkdownBlock[]): string[] {
  return blocks.map(renderBlock);
}

function renderBlock(block: MarkdownBlock): string {
  switch (block.type) {
    case 'fence':
      return `${ANSI.FG_GRAY}────────────────────────────────────────${ANSI.RESET}`;
    case 'code':
      return `${ANSI.FG_YELLOW}  ${block.text}${ANSI.RESET}`;
    case 'h1':
      return `${ANSI.BOLD}${ANSI.FG_CYAN}${block.text.toUpperCase()}${ANSI.RESET}`;
    case 'h2':
      return `${ANSI.BOLD}${ANSI.FG_BLUE}${block.text}${ANSI.RESET}`;
    case 'h3':
      return `${ANSI.BOLD}${ANSI.FG_WHITE}${block.text}${ANSI.RESET}`;
    case 'quote':
      return `${ANSI.FG_GRAY}│ ${ANSI.ITALIC}${block.text}${ANSI.RESET}`;
    case 'list':
      return `  ${ANSI.FG_CYAN}•${ANSI.RESET} ${block.text}`;
    case 'text':
      return block.text
        .replace(/\*\*([^*]+)\*\*/g, `${ANSI.BOLD}$1${ANSI.RESET}`)
        .replace(/`([^`]+)`/g, `${ANSI.FG_YELLOW}$1${ANSI.RESET}`);
  }
}
