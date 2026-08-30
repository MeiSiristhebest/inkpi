export interface FuzzyMatchResult<T> {
  item: T;
  score: number;
  matchedIndices: number[];
}

/**
 * 高性能内存模糊查找器 (1:1 移植自 repos/pi packages/tui/src/fuzzy.ts)
 */
export function fuzzySearch<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
  limit = 20
): FuzzyMatchResult<T>[] {
  const q = query.trim().toLowerCase();
  if (!q) {
    return items.slice(0, limit).map((item) => ({ item, score: 0, matchedIndices: [] }));
  }

  const results: FuzzyMatchResult<T>[] = [];

  for (const item of items) {
    const text = getText(item);
    const target = text.toLowerCase();

    let qIdx = 0;
    let score = 0;
    let consecutive = 0;
    const matchedIndices: number[] = [];

    for (let tIdx = 0; tIdx < target.length && qIdx < q.length; tIdx++) {
      if (target[tIdx] === q[qIdx]) {
        matchedIndices.push(tIdx);
        score += 10 + consecutive * 5; // Bonus for consecutive character matches
        if (tIdx === 0 || target[tIdx - 1] === ' ' || target[tIdx - 1] === '_') {
          score += 15; // Word boundary bonus
        }
        consecutive++;
        qIdx++;
      } else {
        consecutive = 0;
      }
    }

    if (qIdx === q.length) {
      // Shorter matches get higher score
      score += Math.max(0, 50 - (text.length - q.length));
      results.push({ item, score, matchedIndices });
    }
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}
