/**
 * HTML 转义工具（单一实现，避免各导出器各写一份导致转义规则不一致）。
 * 覆盖 `&` `<` `>` `"` `'` `/`，其中单引号与斜杠的转义可防止
 * 单引号属性上下文与未加引号的属性上下文中的注入（XSS）。
 */
const HTML_ESCAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/&/g, '&amp;'],
  [/</g, '&lt;'],
  [/>/g, '&gt;'],
  [/"/g, '&quot;'],
  [/'/g, '&#039;'],
  [/\//g, '&#047;']
];

export function escapeHtml(value: unknown): string {
  const str = value === undefined || value === null ? '' : String(value);
  let out = str;
  for (const [pattern, replacement] of HTML_ESCAPES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
