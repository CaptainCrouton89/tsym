import { calleesOf } from './callees.js';
import { finish } from './receipt.js';
import { resolveSymbol, type ResolveOptions } from './symbols.js';
import { declarationForSymbol } from './ts-program.js';
import type { Callee, Graph, GraphEdge, GraphNode, Result, Symbol } from './types.js';
import type { Workspace } from './workspace.js';

export interface TraceOptions extends ResolveOptions {
  /** How many callee levels to follow. Default 3. */
  depth?: number;
  limit?: number | null;
}

/** Transitive callees of a symbol up to `depth` levels, breadth-first and listed once at their shallowest depth. */
export async function trace(ws: Workspace, address: string, opts: TraceOptions = {}): Promise<Result<Callee>> {
  const startedAt = performance.now();
  const maxDepth = opts.depth ?? 3;
  const symbol = await resolveSymbol(ws, address, opts);
  const root = graphNodeFromSymbol(symbol);
  const nodes = new Map<string, GraphNode>([[root.id, root]]);
  const edges = new Map<string, GraphEdge>();
  const unresolved: import('./types.js').UnresolvedEdge[] = [];
  const seen = new Set<string>([root.id]);
  const items: Callee[] = [];
  let frontier: Array<{ declaration: import('ts-morph').Node; id: string }> = [{ declaration: declarationForSymbol(ws, symbol), id: root.id }];

  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const current of frontier) {
      const result = calleesOf(ws, current.declaration, depth);
      unresolved.push(...result.unresolved);
      for (const callee of result.items) {
        const node = graphNodeFromCallee(callee);
        addEdge(edges, current.id, node.id, callee.callSites);
        if (seen.has(node.id)) continue;
        seen.add(node.id);
        nodes.set(node.id, node);
        const { declaration: _declaration, callable: _callable, ...row } = callee;
        items.push(row);
        next.push({ declaration: callee.callable, id: node.id });
      }
    }
    frontier = next;
  }

  items.sort(compareCallees);
  const finished = finish({ command: 'trace', query: address, root: ws.root, engine: 'ts-morph', filesScanned: ws.projectFor(symbol.path).getSourceFiles().length, startedAt, limit: opts.limit, unresolved: unresolved.length }, items);
  return { ...finished, graph: graphForItems({ nodes: [...nodes.values()], edges: [...edges.values()], unresolved }, finished.items) };
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

/** Keep a limited traversal graph aligned with the rows emitted beside it. */
export function graphForItems(graph: Graph, items: Array<{ path: string; start: { line: number; col: number } }>): Graph {
  const kept = new Set([...items.map(address), ...graph.nodes.filter((node) => node.depth === 0).map((node) => node.id)]);
  return {
    nodes: graph.nodes.filter((node) => kept.has(node.id)),
    edges: graph.edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
    unresolved: graph.unresolved.filter((edge) => kept.has(edge.from)),
  };
}

function compareCallees(a: Callee, b: Callee): number {
  return a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line || a.start.col - b.start.col);
}
