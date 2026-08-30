/**
 * 终端 Markdown 格式化渲染器 (1:1 对标 pi-tui Markdown)
 */

import { Component, type RenderContext } from '../layout.js';
import { visibleWidth, ANSI } from '../render.js';

export class Markdown extends Component {
  public rawText: string;

  constructor(rawText = '') {
    super();
    this.rawText = rawText;
  }

  public setText(text: string): void {
    this.rawText = text;
  }

  public formatMarkdown(width: number): string[] {
    const rawLines = this.rawText.split('\n');
    const result: string[] = [];
    let inCodeBlock = false;

    for (const line of rawLines) {
      if (line.startsWith('```')) {
        inCodeBlock = !inCodeBlock;
        result.push(`${ANSI.FG_GRAY}────────────────────────────────────────${ANSI.RESET}`);
        continue;
      }

      if (inCodeBlock) {
        result.push(`${ANSI.FG_YELLOW}  ${line}${ANSI.RESET}`);
        continue;
      }

      if (line.startsWith('# ')) {
        result.push(`${ANSI.BOLD}${ANSI.FG_CYAN}${line.slice(2).toUpperCase()}${ANSI.RESET}`);
      } else if (line.startsWith('## ')) {
        result.push(`${ANSI.BOLD}${ANSI.FG_BLUE}${line.slice(3)}${ANSI.RESET}`);
      } else if (line.startsWith('### ')) {
        result.push(`${ANSI.BOLD}${ANSI.FG_WHITE}${line.slice(4)}${ANSI.RESET}`);
      } else if (line.startsWith('> ')) {
        result.push(`${ANSI.FG_GRAY}│ ${ANSI.ITALIC}${line.slice(2)}${ANSI.RESET}`);
      } else if (line.startsWith('- ') || line.startsWith('* ')) {
        result.push(`  ${ANSI.FG_CYAN}•${ANSI.RESET} ${line.slice(2)}`);
      } else {
        // Inline bold and code
        let formatted = line
          .replace(/\*\*([^*]+)\*\*/g, `${ANSI.BOLD}$1${ANSI.RESET}`)
          .replace(/`([^`]+)`/g, `${ANSI.FG_YELLOW}$1${ANSI.RESET}`);
        result.push(formatted);
      }
    }

    return result;
  }

  public render(context: RenderContext): string[] {
    const lines = this.formatMarkdown(context.width);
    return lines.slice(0, context.height);
  }
}
