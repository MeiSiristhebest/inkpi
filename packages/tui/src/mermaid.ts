/**
 * 终端 Mermaid ASCII / ANSI 图表渲染器 (1:1 对标 pi-tui grok-mermaid)
 *
 * Parsing is delegated to `./parsers/mermaid-parser.js`; this module only
 * applies ANSI styling to the parsed node/edge graph.
 */

import { ANSI } from './render.js';
import { parseMermaid } from './parsers/mermaid-parser.js';

export interface MermaidNode {
  id: string;
  label: string;
}

export interface MermaidEdge {
  from: string;
  to: string;
  label?: string;
}

export interface MermaidRenderOptions {
  title?: string;
}

export class TerminalMermaid {
  public static renderAsciiFlowchart(mermaidCode: string, options: MermaidRenderOptions = {}): string[] {
    const { nodes, edges } = parseMermaid(mermaidCode);

    if (edges.length === 0 && nodes.length === 0) {
      return [`${ANSI.FG_GRAY}(无有效 Mermaid 流程拓扑)${ANSI.RESET}`];
    }

    const nodeMap = new Map(nodes.map((n) => [n.id, n.label]));
    const output: string[] = [];
    output.push(`${ANSI.BOLD}${ANSI.FG_CYAN}${options.title || 'Mermaid Flowchart'}${ANSI.RESET}`);
    output.push(`${ANSI.FG_GRAY}────────────────────────────────────────${ANSI.RESET}`);

    // Render nodes and outgoing links
    for (const node of nodes) {
      const outgoing = edges.filter((e) => e.from === node.id);
      output.push(`${ANSI.FG_YELLOW}[${node.label || node.id}]${ANSI.RESET}`);
      for (const edge of outgoing) {
        const targetLabel = nodeMap.get(edge.to) || edge.to;
        const edgeText = edge.label ? ` ──(${edge.label})──>` : ' ──────>';
        output.push(`  ${ANSI.FG_CYAN}│${edgeText}${ANSI.RESET} ${ANSI.FG_GREEN}[${targetLabel}]${ANSI.RESET}`);
      }
    }

    return output;
  }
}
