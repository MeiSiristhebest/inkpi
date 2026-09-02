import { describe, it, expect } from 'vitest';
import { parseMermaid } from './mermaid-parser.js';

describe('parseMermaid (pure, no ANSI)', () => {
  it('extracts nodes and labelled edges from a flowchart', () => {
    const { nodes, edges } = parseMermaid(`
      flowchart TD
        A[主角遇伏] --> B[掉落悬崖]
        B -->|获得传承| C[重回家族]
    `);
    expect(nodes.map((n) => n.label)).toEqual(['主角遇伏', '掉落悬崖', '重回家族']);
    expect(edges).toEqual([
      { from: 'A', to: 'B', label: undefined },
      { from: 'B', to: 'C', label: '获得传承' }
    ]);
  });

  it('skips graph/flowchart/%% directive lines', () => {
    const { nodes, edges } = parseMermaid(`
      flowchart TD
      %% 这是注释
        X[起点] --> Y[终点]
    `);
    expect(nodes.map((n) => n.id)).toEqual(['X', 'Y']);
    expect(edges).toHaveLength(1);
  });

  it('returns an empty graph for non-Mermaid input', () => {
    const result = parseMermaid('this is not a diagram');
    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});
