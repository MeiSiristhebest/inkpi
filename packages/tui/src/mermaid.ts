/**
 * 终端 Mermaid ASCII / ANSI 图表渲染器 (1:1 对标 pi-tui grok-mermaid)
 */

import { ANSI } from './render.js';

export interface MermaidNode {
  id: string;
  label: string;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
}

export class TerminalMermaid {
  public static renderAsciiFlowchart(mermaidCode: string): string[] {
    const lines = mermaidCode.trim().split('\n');
    const nodes: Map<string, string> = new Map();
    const edges: Array<{ from: string; to: string; label?: string }> = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('graph') || line.startsWith('flowchart') || line.startsWith('%%')) {
        continue;
      }

      // Match A[Label] -->|text| B[Label2] or A --> B
      const edgeMatch = line.match(/([a-zA-Z0-9_-]+)(?:\[(.*?)\])?\s*-->\s*(?:\|(.*?)\|)?\s*([a-zA-Z0-9_-]+)(?:\[(.*?)\])?/);
      if (edgeMatch) {
        const [, fromId, fromLabel, edgeLabel, toId, toLabel] = edgeMatch;
        if (fromLabel || !nodes.has(fromId)) {
          nodes.set(fromId, fromLabel || fromId);
        }
        if (toLabel || !nodes.has(toId)) {
          nodes.set(toId, toLabel || toId);
        }
        edges.push({ from: fromId, to: toId, label: edgeLabel });
      }
    }

    if (edges.length === 0 && nodes.size === 0) {
      return [`${ANSI.FG_GRAY}(无有效 Mermaid 流程拓扑)${ANSI.RESET}`];
    }

    const output: string[] = [];
    output.push(`${ANSI.BOLD}${ANSI.FG_CYAN}📊 剧情 / 实体关系拓扑图 (Mermaid ASCII)${ANSI.RESET}`);
    output.push(`${ANSI.FG_GRAY}────────────────────────────────────────${ANSI.RESET}`);

    // Render nodes and outgoing links
    for (const [id, label] of nodes.entries()) {
      const outgoing = edges.filter((e) => e.from === id);
      output.push(`${ANSI.FG_YELLOW}[${label || id}]${ANSI.RESET}`);
      for (const edge of outgoing) {
        const targetLabel = nodes.get(edge.to) || edge.to;
        const edgeText = edge.label ? ` ──(${edge.label})──>` : ' ──────>';
        output.push(`  ${ANSI.FG_CYAN}│${edgeText}${ANSI.RESET} ${ANSI.FG_GREEN}[${targetLabel}]${ANSI.RESET}`);
      }
    }

    return output;
  }
}
