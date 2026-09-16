import { calleesOf } from './callees.js';
import { finish, matchesPathFilters, type PathFilters } from './receipt.js';
import { asAddresses, resolveSymbol, uniqueSymbols, type ResolveOptions } from './symbols.js';
import { declarationForSymbol } from './ts-program.js';
import type { Callee, Graph, GraphEdge, GraphNode, Result, Symbol } from './types.js';
import type { Workspace } from './workspace.js';

export interface TraceOptions extends ResolveOptions, PathFilters {
  /** How many callee levels to follow. Default 3. */
  depth?: number;
  limit?: number | null;
}

/** Transitive callees of one or more symbols up to `depth` levels, breadth-first and listed once at their shallowest depth. */
export async function trace(ws: Workspace, addresses: string | readonly string[], opts: TraceOptions = {}): Promise<Result<Callee>> {
  const startedAt = performance.now();
  const maxDepth = opts.depth ?? 3;
  const inputs = asAddresses(addresses);
  const symbols = uniqueSymbols(await Promise.all(inputs.map((address) => resolveSymbol(ws, address, opts))));
  const roots = symbols.map(graphNodeFromSymbol);
  const nodes = new Map(roots.map((root) => [root.id, root]));
  const edges = new Map<string, GraphEdge>();
  const unresolved: import('./types.js').UnresolvedEdge[] = [];
  const seen = new Set(nodes.keys());
  const rows = new Map<string, Callee>();
  let frontier: Array<{ declaration: import('ts-morph').Node; id: string }> = symbols.map((symbol) => ({ declaration: declarationForSymbol(ws, symbol), id: address(symbol) }));

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const current of frontier) {
      const result = calleesOf(ws, current.declaration, depth);
      unresolved.push(...result.unresolved);
      for (const callee of result.items) {
        const node = graphNodeFromCallee(callee);
        addEdge(edges, current.id, node.id, callee.callSites);
        const { declaration: _declaration, callable: _callable, ...row } = callee;
        if (seen.has(node.id)) {
          const existing = rows.get(node.id);
          if (existing) existing.callSites += row.callSites;
          continue;
        }
        rows.set(node.id, row);
        seen.add(node.id);
        nodes.set(node.id, node);
        next.push({ declaration: callee.callable, id: node.id });
      }
    }
    frontier = next;
  }

  const prunedGraph = graphAfterExclusion({ nodes: [...nodes.values()], edges: [...edges.values()], unresolved }, opts.exclude);
  const remaining = new Set(prunedGraph.nodes.map((node) => node.id));
  const items = [...rows.values()]
    .filter((row) => remaining.has(address(row)) && matchesPathFilters(row.path, { in: opts.in }))
    .sort(compareCallees);
  const finished = finish({ command: 'trace', query: inputs.join(' '), root: ws.root, engine: 'ts-morph', filesScanned: Math.max(...symbols.map((symbol) => ws.projectFor(symbol.path).getSourceFiles().length)), startedAt, limit: opts.limit }, items);
  const graph = graphForItems(prunedGraph, new Set(finished.items.map(address)));
  finished.receipt.excluded = rows.size - finished.items.length;
  finished.receipt.unresolved = graph.unresolved.length;
  return { ...finished, graph };
}

export function graphNodeFromSymbol(symbol: Symbol): GraphNode {
  return { id: address(symbol), path: symbol.path, start: symbol.start, end: symbol.end, kind: symbol.kind, name: symbol.name, qualifiedName: symbol.qualifiedName, depth: 0 };
}

export function graphNodeFromCallee(callee: Callee): GraphNode {
  return { id: address(callee), path: callee.path, start: callee.start, end: callee.end, kind: callee.kind, name: callee.name, qualifiedName: callee.qualifiedName, depth: callee.depth };
}

export function address(loc: { path: string; start: { line: number; col: number } }): string {
  return `${loc.path}:${loc.start.line}:${loc.start.col}`;
}

export function addEdge(edges: Map<string, GraphEdge>, from: string, to: string, callSites: number): void {
  const key = `${from}\0${to}`;
  const existing = edges.get(key);
  if (existing) existing.callSites += callSites;
  else edges.set(key, { from, to, callSites });
}

/** Remove excluded nodes, then retain only nodes still reachable from a surviving seed. */
export function graphAfterExclusion(graph: Graph, exclude: PathFilters['exclude'], reverseEdges = false): Graph {
  const allowed = new Set(graph.nodes.filter((node) => matchesPathFilters(node.path, { exclude })).map((node) => node.id));
  const { children } = traversalLinks(graph, allowed, reverseEdges);
  const kept = new Set(graph.nodes.filter((node) => node.depth === 0 && allowed.has(node.id)).map((node) => node.id));
  const frontier = [...kept];
  for (let i = 0; i < frontier.length; i++) {
    for (const child of children.get(frontier[i]!) ?? []) {
      if (!kept.has(child)) {
        kept.add(child);
        frontier.push(child);
      }
    }
  }
  return selectGraph(graph, kept);
}

/** Keep returned rows, every seed, and the connecting paths between them. */
export function graphForItems(graph: Graph, rowIds: ReadonlySet<string>, reverseEdges = false): Graph {
  const ids = new Set(graph.nodes.map((node) => node.id));
  const { parents } = traversalLinks(graph, ids, reverseEdges);
  const kept = new Set(graph.nodes.filter((node) => node.depth === 0).map((node) => node.id));
  const frontier = [...rowIds].filter((id) => ids.has(id));
  for (let i = 0; i < frontier.length; i++) {
    const id = frontier[i]!;
    if (kept.has(id)) continue;
    kept.add(id);
    for (const parent of parents.get(id) ?? []) frontier.push(parent);
  }
  const selected = selectGraph(graph, kept);
  return {
    ...selected,
    nodes: selected.nodes.map((node) => {
      if (node.depth === 0 || rowIds.has(node.id)) {
        const { connecting: _connecting, ...rowOrSeed } = node;
        return rowOrSeed;
      }
      return { ...node, connecting: true };
    }),
  };
}

function traversalLinks(graph: Graph, allowed: ReadonlySet<string>, reverseEdges: boolean): { children: Map<string, string[]>; parents: Map<string, string[]> } {
  const children = new Map<string, string[]>();
  const parents = new Map<string, string[]>();
  const link = (parent: string, child: string): void => {
    children.set(parent, [...(children.get(parent) ?? []), child]);
    parents.set(child, [...(parents.get(child) ?? []), parent]);
  };
  for (const edge of graph.edges) {
    if (!allowed.has(edge.from) || !allowed.has(edge.to)) continue;
    if (reverseEdges) link(edge.to, edge.from);
    else link(edge.from, edge.to);
  }
  return { children, parents };
}

function selectGraph(graph: Graph, kept: ReadonlySet<string>): Graph {
  return {
    nodes: graph.nodes.filter((node) => kept.has(node.id)),
    edges: graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
    unresolved: graph.unresolved.filter((edge) => kept.has(edge.from)),
  };
}

function compareCallees(a: Callee, b: Callee): number {
  return a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line || a.start.col - b.start.col);
}
