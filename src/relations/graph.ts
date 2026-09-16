import { matchesPathFilters } from '../core/receipt.js';
import type { Graph, GraphEdge, GraphNode, RelationRow, TraversalResult, UnresolvedSite } from './types.js';
import type { Direction, EdgeKind } from './types.js';

interface MutableEdge { from: string; to: string; kind: EdgeKind; siteIds: Set<string>; }

export class GraphBuilder {
  readonly nodes = new Map<string, GraphNode>();
  private readonly edges = new Map<string, MutableEdge>();
  private readonly unresolved = new Map<string, UnresolvedSite>();

  addNode(node: GraphNode): void {
    const prior = this.nodes.get(node.id);
    if (!prior || node.depth < prior.depth) this.nodes.set(node.id, node);
  }

  addEdge(from: string, to: string, kind: EdgeKind, siteId: string): void {
    const key = `${from}\0${to}\0${kind}`;
    const edge = this.edges.get(key) ?? { from, to, kind, siteIds: new Set<string>() };
    edge.siteIds.add(siteId);
    this.edges.set(key, edge);
  }

  addUnresolved(site: UnresolvedSite): void { this.unresolved.set(site.siteId, site); }

  build(): Graph {
    return {
      nodes: [...this.nodes.values()].sort(compareNodes),
      edges: [...this.edges.values()].map((edge): GraphEdge => ({ ...edge, siteIds: [...edge.siteIds].sort(), callSites: edge.siteIds.size })).sort(compareEdges),
      unresolved: [...this.unresolved.values()].sort(compareUnresolved),
    };
  }
}

/** Remove excluded declarations, then retain only declarations still reachable from surviving seeds. */
export function graphAfterExclusion(graph: Graph, exclude: readonly string[], direction: Direction): Graph {
  const allowed = new Set(graph.nodes.filter((node) => matchesPathFilters(node.path, { exclude })).map((node) => node.id));
  const links = traversalLinks(graph, allowed, direction);
  const kept = new Set(graph.nodes.filter((node) => node.depth === 0 && allowed.has(node.id)).map((node) => node.id));
  const queue = [...kept];
  for (let index = 0; index < queue.length; index++) for (const child of links.children.get(queue[index]!) ?? []) if (!kept.has(child)) { kept.add(child); queue.push(child); }
  return selectGraph(graph, kept);
}

/** Keep returned rows, seeds, and every declaration connecting a seed to a returned row. */
export function graphForItems(graph: Graph, rowIds: ReadonlySet<string>, direction: Direction): Graph {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const links = traversalLinks(graph, ids, direction);
  const kept = new Set(graph.nodes.filter((node) => node.depth === 0).map((node) => node.id));
  const queue = [...rowIds].filter((id) => ids.has(id));
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]!;
    if (kept.has(id)) continue;
    kept.add(id);
    for (const parent of links.parents.get(id) ?? []) queue.push(parent);
  }
  const selected = selectGraph(graph, kept);
  return { ...selected, nodes: selected.nodes.map((node) => node.depth === 0 || rowIds.has(node.id) ? withoutConnecting(node) : { ...node, connecting: true }) };
}

export function projectGraph(graph: Graph, direction: Direction, inGlobs: readonly string[]): TraversalResult {
  const preProjection = graph.nodes.filter((node) => node.depth > 0).length;
  const rowIds = new Set(graph.nodes.filter((node) => node.depth > 0 && matchesPathFilters(node.path, { in: inGlobs })).map((node) => node.id));
  const projected = graphForItems(graph, rowIds, direction);
  const rows = rowsForGraph(projected, direction);
  const unresolved = projected.unresolved.length;
  const dispatch = new Set([
    ...projected.unresolved.filter((site) => site.dispatch).map((site) => site.siteId),
    ...projected.edges.filter((edge) => edge.kind === 'impl').flatMap((edge) => edge.siteIds),
  ]).size;
  return { graph: projected, rows, excluded: preProjection - rows.length, unresolved, dispatch };
}

export function mergeGraphs(graphs: readonly Graph[]): Graph {
  const builder = new GraphBuilder();
  for (const graph of graphs) {
    for (const node of graph.nodes) {
      const prior = builder.nodes.get(node.id);
      const connecting = node.connecting && prior?.connecting;
      builder.addNode(connecting ? { ...node, connecting: true } : withoutConnecting(node));
    }
    for (const edge of graph.edges) for (const siteId of edge.siteIds) builder.addEdge(edge.from, edge.to, edge.kind, siteId);
    for (const site of graph.unresolved) builder.addUnresolved(site);
  }
  return builder.build();
}

export function rowsForGraph(graph: Graph, direction: Direction): RelationRow[] {
  const rows = new Map<string, RelationRow>();
  for (const node of graph.nodes) if (node.depth > 0 && !node.connecting) rows.set(node.id, { ...node, callSites: 0, edgeKinds: [] });
  for (const edge of graph.edges) {
    const row = rows.get(direction === 'calls' ? edge.to : edge.from);
    if (!row) continue;
    row.callSites += edge.callSites;
    row.edgeKinds = [...new Set([...row.edgeKinds, edge.kind])];
  }
  return [...rows.values()].sort(compareRows);
}

export function traversalLinks(graph: Graph, allowed: ReadonlySet<string>, direction: Direction): { children: Map<string, string[]>; parents: Map<string, string[]> } {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const link = (parent: string, child: string): void => { children.set(parent, [...(children.get(parent) ?? []), child]); parents.set(child, [...(parents.get(child) ?? []), parent]); };
  for (const edge of graph.edges) if (allowed.has(edge.from) && allowed.has(edge.to)) direction === 'calls' ? link(edge.from, edge.to) : link(edge.to, edge.from);
  return { children, parents };
}

export function selectGraph(graph: Graph, ids: ReadonlySet<string>): Graph {
  return { nodes: graph.nodes.filter((node) => ids.has(node.id)), edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)), unresolved: graph.unresolved.filter((site) => ids.has(site.from)) };
}

function withoutConnecting(node: GraphNode): GraphNode { const { connecting: _connecting, ...rest } = node; return rest; }
function compareNodes(a: GraphNode, b: GraphNode): number { return a.depth - b.depth || a.id.localeCompare(b.id); }
function compareEdges(a: GraphEdge, b: GraphEdge): number { return a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.kind.localeCompare(b.kind); }
function compareUnresolved(a: UnresolvedSite, b: UnresolvedSite): number { return a.siteId.localeCompare(b.siteId); }
function compareRows(a: RelationRow, b: RelationRow): number { return a.depth - b.depth || a.path.localeCompare(b.path) || a.start.line - b.start.line || a.start.col - b.start.col; }
