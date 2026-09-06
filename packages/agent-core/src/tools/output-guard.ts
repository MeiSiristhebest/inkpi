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
