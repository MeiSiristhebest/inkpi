/**
 * 输出字符截断与终端防爆守卫 (Output Guard)
 *
 * 防止长文本生成时模型失控复读或超大批量输出撑爆上下文及 UI 渲染层。
 */

export interface OutputGuardOptions {
  maxCharacters?: number;
  truncationMessage?: string;
}

export const DEFAULT_MAX_OUTPUT_CHARS = 32_000;

/** Retain the newest bounded window while counting all discarded UTF-16 characters. */
export class RetainedOutputWindow {
  private content = '';
  private totalCharacters = 0;

  constructor(private readonly maxCharacters = DEFAULT_MAX_OUTPUT_CHARS) {
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1) throw new Error('Invalid output window size.');
  }

  append(text: string): void {
    this.totalCharacters += text.length;
    let retained = (this.content + text).slice(-this.maxCharacters);
    const first = retained.charCodeAt(0);
    if (first >= 0xdc00 && first <= 0xdfff) retained = retained.slice(1);
    this.content = retained;
  }

  snapshot(): { content: string; totalCharacters: number; skippedCharacters: number } {
    return {
      content: this.content,
      totalCharacters: this.totalCharacters,
      skippedCharacters: this.totalCharacters - this.content.length
    };
  }
}

export interface GuardResult {
  content: string;
  truncated: boolean;
  originalLength: number;
}

export function enforceOutputGuard(text: string, options?: OutputGuardOptions): GuardResult {
  const max = options?.maxCharacters ?? DEFAULT_MAX_OUTPUT_CHARS;
  if (text.length <= max) {
    return { content: text, truncated: false, originalLength: text.length };
  }

  const truncMsg =
    options?.truncationMessage ||
    `\n\n... [Output truncated at ${max} characters by OutputGuard to prevent overflow. Use pagination or targeted queries for more content.]`;

  const safeSlice = text.slice(0, max);
  return {
    content: safeSlice + truncMsg,
    truncated: true,
    originalLength: text.length
  };
}
