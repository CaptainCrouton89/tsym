import { Node } from 'ts-morph';
import { callersOf } from './callers.js';
import { finish, matchesPathFilters, type PathFilters } from './receipt.js';
import { asAddresses, resolveSymbol, uniqueSymbols, type ResolveOptions } from './symbols.js';
import { lineTextAt, locOf, nameIdentifier, referencesTo, type NameNode } from './ts-program.js';
import { addEdge, address, graphAfterExclusion, graphForItems, graphNodeFromSymbol } from './trace.js';
import type { Caller, GraphEdge, GraphNode, Result } from './types.js';
import type { Workspace } from './workspace.js';

export interface ImpactOptions extends ResolveOptions, PathFilters {
  /** How many caller levels to follow. Default 3. */
  depth?: number;
  limit?: number | null;
}

/**
 * Transitive callers of a symbol up to `depth` levels (breadth-first; each caller listed once at its
 * shallowest depth), plus `export { X }` / `export { X } from` statements that re-export it (kind `export`, depth 1).
 */
export async function impact(ws: Workspace, addresses: string | readonly string[], opts: ImpactOptions = {}): Promise<Result<Caller>> {
  const startedAt = performance.now();
  const maxDepth = opts.depth ?? 3;
  const inputs = asAddresses(addresses);
  const symbols = uniqueSymbols(await Promise.all(inputs.map((address) => resolveSymbol(ws, address, opts))));
  const roots = symbols.map(graphNodeFromSymbol);
  const nodes = new Map(roots.map((root) => [root.id, root]));
  const edges = new Map<string, GraphEdge>();
  const seen = new Set(nodes.keys());
  const rows = new Map<string, Caller>();
  let frontier = symbols.map((symbol) => ({ id: nameIdentifier(ws, symbol), graphId: address(symbol) }));
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const current of frontier) {
      for (const caller of callersOf(ws, current.id, depth)) {
        const k = key(caller);
        addEdge(edges, k, current.graphId, caller.callSites);
        const { id: callerId, ...row } = caller;
        if (seen.has(k)) {
          const existing = rows.get(k);
          if (existing) existing.callSites += row.callSites;
          continue;
        }
        rows.set(k, row);
        seen.add(k);
        nodes.set(k, graphNodeFromCaller(caller));
        if (callerId) next.push({ id: callerId, graphId: k });
      }
    }
    frontier = next;
  }

  for (const symbol of symbols) {
    const rootId = nameIdentifier(ws, symbol);
    for (const ref of referencesTo(rootId)) {
      const node = ref.getNode();
      const spec = node.getParent();
      if (!spec || !Node.isExportSpecifier(spec)) continue;
      const stmt = spec.getParent().getParent(); // ExportSpecifier → NamedExports → ExportDeclaration
      const row: Caller = { ...locOf(ws, stmt), kind: 'export', name: spec.getName(), qualifiedName: spec.getAliasNode()?.getText() ?? spec.getName(), depth: 1, callSites: 1, text: lineTextAt(stmt) };
      const k = key(row);
      addEdge(edges, k, address(symbol), row.callSites);
      if (seen.has(k)) {
        const existing = rows.get(k);
        if (existing) existing.callSites += row.callSites;
        continue;
      }
      rows.set(k, row);
      seen.add(k);
      nodes.set(k, graphNodeFromCaller(row));
    }
  }

  const prunedGraph = graphAfterExclusion({ nodes: [...nodes.values()], edges: [...edges.values()], unresolved: [] }, opts.exclude, true);
  const remaining = new Set(prunedGraph.nodes.map((node) => node.id));
  const items = [...rows.values()]
    .filter((row) => remaining.has(key(row)) && matchesPathFilters(row.path, { in: opts.in }))
    .sort(compareCallers);
  const finished = finish({ command: 'impact', query: inputs.join(' '), root: ws.root, engine: 'ts-morph', filesScanned: Math.max(...symbols.map((symbol) => ws.projectFor(symbol.path).getSourceFiles().length)), startedAt, limit: opts.limit }, items);
  const graph = graphForItems(prunedGraph, new Set(finished.items.map(key)), true);
  finished.receipt.excluded = rows.size - finished.items.length;
  finished.receipt.unresolved = graph.unresolved.length;
  return { ...finished, graph };
}

function key(loc: { path: string; start: { line: number; col: number } }): string {
  return address(loc);
}

function compareCallers(a: Caller, b: Caller): number {
  return a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line || a.start.col - b.start.col);
}

function graphNodeFromCaller(caller: Caller): GraphNode {
  return { id: address(caller), path: caller.path, start: caller.start, end: caller.end, kind: caller.kind, name: caller.name, qualifiedName: caller.qualifiedName, depth: caller.depth };
}
