import { describe, expect, it } from 'vitest';
import {
  AltScreenSearchIndex,
  buildSearchCorpus,
  findSearchCorpusMatches,
  stripTerminalSequences
} from '../packages/tui/src/alt-screen-search.js';

describe('AltScreenSearchIndex (Linear Search Performance & Correctness)', () => {
  it('should strip terminal escape sequences accurately', () => {
    const raw = '\x1b[31mHello\x1b[0m \x1b_pi:c\x07World';
    expect(stripTerminalSequences(raw)).toBe('Hello World');
  });

  it('should build corpus and match query across ASCII runs', () => {
    const lines = ['const value = 42;', 'function testRunner() {', '  return value * 2;', '}'];

    const corpus = buildSearchCorpus(lines);
    expect(corpus.text).toContain('const value = 42;');

    const matches = findSearchCorpusMatches(corpus, 'value');
    expect(matches.length).toBe(2);
    expect(matches[0].segments[0].row).toBe(0);
    expect(matches[1].segments[0].row).toBe(2);
  });

  it('should cache search corpus when lines remain unchanged', () => {
    const index = new AltScreenSearchIndex();
    const lines = ['First Line of Narrative', 'Second Line with Target Keyword'];

    const res1 = index.search(lines, 'Keyword');
    expect(res1.matches.length).toBe(1);
    expect(res1.changed).toBe(true);

    // Same query, same lines -> not changed, cache hit
    const res2 = index.search(lines, 'Keyword');
    expect(res2.matches.length).toBe(1);
    expect(res2.changed).toBe(false);

    // New query -> changed
    const res3 = index.search(lines, 'Narrative');
    expect(res3.matches.length).toBe(1);
    expect(res3.changed).toBe(true);
  });
});
