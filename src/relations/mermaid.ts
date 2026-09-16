import { createHash } from 'node:crypto';
import path from 'node:path';
import type { Graph } from './types.js';

/** Pure graph-to-Mermaid renderer. */
export function renderGraph(graph: Graph): string {
  const lines = ['flowchart TD'];
  const ids = new Map(graph.nodes.map((node) => [node.id, mermaidId(node.id)]));
  const directories = new Map<string, typeof graph.nodes>();
  for (const node of graph.nodes) {
    const directory = path.posix.dirname(node.path);
    const nodes = directories.get(directory) ?? [];
    nodes.push(node);
    directories.set(directory, nodes);
  }
  for (const [directory, nodes] of [...directories].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  subgraph ${mermaidId(`directory:${directory}`)}["${escape(directory)}"]`);
    for (const node of nodes.sort((a, b) => a.id.localeCompare(b.id))) lines.push(`    ${ids.get(node.id)}["${escape(node.qualifiedName)}<br/>${escape(node.id)}"]`);
    lines.push('  end');
  }
  const connecting = graph.nodes.filter((node) => node.connecting).map((node) => ids.get(node.id)!);
  if (connecting.length) { lines.push('  classDef connecting stroke-dasharray: 5 5'); lines.push(`  class ${connecting.join(',')} connecting`); }
  for (const edge of graph.edges) {
    const label = `${edge.kind === 'impl' ? 'impl' : ''}${edge.callSites > 1 ? `${edge.kind === 'impl' ? ' ' : ''}${edge.callSites}` : ''}`;
    lines.push(`  ${ids.get(edge.from)} ${edge.kind === 'impl' ? '-.->' : '-->'}${label ? `|${label}|` : ''} ${ids.get(edge.to)}`);
  }
  const reasons = [...new Set(graph.unresolved.map((site) => site.reason))].sort();
  for (const reason of reasons) lines.push(`  unresolved_${reason}["${reason}"]`);
  for (const site of graph.unresolved) lines.push(`  ${ids.get(site.from)} -.-> unresolved_${site.reason}`);
  return `${lines.join('\n')}\n`;
}
function mermaidId(value: string): string { return `n_${createHash('sha256').update(value).digest('hex').slice(0, 16)}`; }
function escape(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
