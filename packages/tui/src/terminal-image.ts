import { visibleWidth } from './width.js';

export interface TerminalImageOptions {
  protocol?: 'kitty' | 'iterm2' | 'ascii' | 'auto';
  width?: number;
  height?: number;
  preserveAspectRatio?: boolean;
}

export function detectTerminalProtocol(): 'kitty' | 'iterm2' | 'ascii' {
  const term = process.env.TERM || '';
  const termProgram = process.env.TERM_PROGRAM || '';

  if (termProgram.includes('iTerm') || termProgram.includes('WezTerm')) {
    return 'iterm2';
  }
  if (term.includes('kitty') || process.env.KITTY_WINDOW_ID) {
    return 'kitty';
  }
  return 'ascii';
}

function isBase64(value: string): boolean {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/.test(value)) return false;
  const normalized = value.replace(/=+$/, '');
  return Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') === normalized;
}

function renderAsciiFallback(options: TerminalImageOptions): string {
  const width = options.width || 20;
  const height = options.height || 6;
  const lines: string[] = [];
  lines.push(`┌${'─'.repeat(width - 2)}┐`);
  const middle = Math.floor((height - 2) / 2);
  for (let i = 0; i < height - 2; i++) {
    if (i === middle) {
      const label = ' 🖼️ [立绘/图像] ';
      const pad = Math.max(0, width - 2 - visibleWidth(label));
      lines.push(`│${label}${' '.repeat(pad)}│`);
    } else {
      lines.push(`│${' '.repeat(width - 2)}│`);
    }
  }
  lines.push(`└${'─'.repeat(width - 2)}┘`);
  return lines.join('\n');
}

/**
 * 将图片 Buffer 或 Base64 编码转换为终端内联控制码
 */
export function renderTerminalImage(imageBufferOrBase64: Buffer | string, options: TerminalImageOptions = {}): string {
  const protocol = options.protocol && options.protocol !== 'auto' ? options.protocol : detectTerminalProtocol();
  const base64 = typeof imageBufferOrBase64 === 'string' ? imageBufferOrBase64 : imageBufferOrBase64.toString('base64');
  if (!isBase64(base64)) return renderAsciiFallback(options);

  if (protocol === 'kitty') {
    // Kitty Graphics Protocol: \x1b_Gf=100,a=T,m=0;<base64>\x1b\
    return `\x1b_Ga=T,f=100,m=0;${base64}\x1b\\`;
  }

  if (protocol === 'iterm2') {
    // iTerm2 Inline Image Protocol: \x1b]1337;File=inline=1;width=...:<base64>\x07
    const w = options.width ? `;width=${options.width}` : '';
    const h = options.height ? `;height=${options.height}` : '';
    return `\x1b]1337;File=inline=1${w}${h}:${base64}\x07`;
  }

  // ASCII Fallback block placeholder
  return renderAsciiFallback(options);
}
