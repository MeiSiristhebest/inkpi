import { describe, it, expect } from 'vitest';
import { parseMarkdown } from './markdown-parser.js';

describe('parseMarkdown (pure, no ANSI)', () => {
  it('classifies headings, quote, list and text blocks', () => {
    const blocks = parseMarkdown('# Title\n## Sub\n### Deep\n> quote\n- item\n* star\nplain');
    expect(blocks.map((b) => b.type)).toEqual(['h1', 'h2', 'h3', 'quote', 'list', 'list', 'text']);
    expect(blocks[0].text).toBe('Title');
    expect(blocks[3].text).toBe('quote');
    expect(blocks[4].text).toBe('item');
    expect(blocks[6].text).toBe('plain');
  });

  it('toggles code fences and captures inner lines as code blocks', () => {
    const blocks = parseMarkdown('before\n```ts\nconst a = 1;\n```\nafter');
    expect(blocks.map((b) => b.type)).toEqual(['text', 'fence', 'code', 'fence', 'text']);
    expect(blocks[2].text).toBe('const a = 1;');
  });

  it('produces no ANSI escape codes in the AST', () => {
    const blocks = parseMarkdown('# Heading\n**bold** `code`');
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain('\x1b[');
  });
});
