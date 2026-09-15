import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Graph } from './types.js';

/** Render a traversal graph as a Mermaid flowchart grouped by declaration directory. */
export function renderGraph(graph: Graph): string {
  const lines = ['flowchart TD'];
  const nodeId = new Map(graph.nodes.map((node) => [node.id, mermaidId(node.id)]));
  const byDirectory = new Map<string, typeof graph.nodes>();
  for (const node of graph.nodes) {
    const directory = path.posix.dirname(node.path);
    const nodes = byDirectory.get(directory) ?? [];
    nodes.push(node);
    byDirectory.set(directory, nodes);
  }

  for (const [directory, nodes] of [...byDirectory].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  subgraph ${mermaidId(`directory:${directory}`)}["${escape(directory)}"]`);
    for (const node of nodes.sort((a, b) => a.id.localeCompare(b.id))) {
      lines.push(`    ${nodeId.get(node.id)}["${escape(node.qualifiedName)}<br/>${escape(node.id)}"]`);
    }
    lines.push('  end');
  }

  for (const edge of graph.edges) {
    const label = edge.callSites > 1 ? `|${edge.callSites}|` : '';
    lines.push(`  ${nodeId.get(edge.from)} -->${label} ${nodeId.get(edge.to)}`);
  }

  const reasons = [...new Set(graph.unresolved.map((edge) => edge.reason))].sort();
  for (const reason of reasons) lines.push(`  unresolved_${reason}["${reason}"]`);
  for (const edge of graph.unresolved) lines.push(`  ${nodeId.get(edge.from)} -.-> unresolved_${edge.reason}`);

  return lines.join('\n') + '\n';
}

function mermaidId(value: string): string {
  return `n_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
