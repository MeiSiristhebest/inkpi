/**
 * Pure Mermaid flowchart parser — no ANSI, no terminal coupling.
 *
 * Extracts the directed graph (nodes + labelled edges) from a Mermaid
 * `flowchart`/`graph` definition. The ANSI renderer (`mermaid.ts`) consumes the
 * result, so parsing is testable without producing terminal escape codes.
 */

import type { MermaidEdge, MermaidNode } from '../mermaid.js';

export interface ParsedMermaid {
  nodes: MermaidNode[];
  edges: MermaidEdge[];
}

export function parseMermaid(mermaidCode: string): ParsedMermaid {
  const lines = mermaidCode.trim().split('\n');
  const nodeMap = new Map<string, string>();
  const edges: MermaidEdge[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('graph') || line.startsWith('flowchart') || line.startsWith('%%')) {
      continue;
    }

    // Match A[Label] -->|text| B[Label2] or A --> B
    const edgeMatch = line.match(
      /([a-zA-Z0-9_-]+)(?:\[(.*?)\])?\s*-->\s*(?:\|(.*?)\|)?\s*([a-zA-Z0-9_-]+)(?:\[(.*?)\])?/
    );
    if (edgeMatch) {
      const [, fromId, fromLabel, edgeLabel, toId, toLabel] = edgeMatch;
      if (fromLabel || !nodeMap.has(fromId)) {
        nodeMap.set(fromId, fromLabel || fromId);
      }
      if (toLabel || !nodeMap.has(toId)) {
        nodeMap.set(toId, toLabel || toId);
      }
      edges.push({ from: fromId, to: toId, label: edgeLabel });
    }
  }

  const nodes: MermaidNode[] = [...nodeMap.entries()].map(([id, label]) => ({ id, label }));
  return { nodes, edges };
}
