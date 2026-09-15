import { Node } from 'ts-morph';
import { callersOf } from './callers.js';
import { finish } from './receipt.js';
import { resolveSymbol, type ResolveOptions } from './symbols.js';
import { lineTextAt, locOf, nameIdentifier, referencesTo, type NameNode } from './ts-program.js';
import { addEdge, address, graphForItems, graphNodeFromSymbol } from './trace.js';
import type { Caller, GraphEdge, GraphNode, Result } from './types.js';
import type { Workspace } from './workspace.js';

export interface ImpactOptions extends ResolveOptions {
  /** How many caller levels to follow. Default 3. */
  depth?: number;
  limit?: number | null;
}

/**
 * Transitive callers of a symbol up to `depth` levels (breadth-first; each caller listed once at its
 * shallowest depth), plus `export { X }` / `export { X } from` statements that re-export it (kind `export`, depth 1).
 */
export async function impact(ws: Workspace, address: string, opts: ImpactOptions = {}): Promise<Result<Caller>> {
  const startedAt = performance.now();
  const maxDepth = opts.depth ?? 3;
  const symbol = await resolveSymbol(ws, address, opts);
  const rootId = nameIdentifier(ws, symbol);

  const root = graphNodeFromSymbol(symbol);
  const nodes = new Map<string, GraphNode>([[root.id, root]]);
  const edges = new Map<string, GraphEdge>();
  const seen = new Set<string>([root.id]);
  const items: Caller[] = [];
  let frontier = [{ id: rootId, graphId: root.id }];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: typeof frontier = [];
    for (const current of frontier) {
      for (const caller of callersOf(ws, current.id, depth)) {
        const k = key(caller);
        addEdge(edges, k, current.graphId, caller.callSites);
        if (seen.has(k)) continue;
        seen.add(k);
        nodes.set(k, graphNodeFromCaller(caller));
        const { id: callerId, ...row } = caller;
        items.push(row);
        if (callerId) next.push({ id: callerId, graphId: k });
      }
    }
    frontier = next;
  }

  for (const ref of referencesTo(rootId)) {
    const node = ref.getNode();
    const spec = node.getParent();
    if (!spec || !Node.isExportSpecifier(spec)) continue;
    const stmt = spec.getParent().getParent(); // ExportSpecifier → NamedExports → ExportDeclaration
    const row: Caller = { ...locOf(ws, stmt), kind: 'export', name: spec.getName(), qualifiedName: spec.getAliasNode()?.getText() ?? spec.getName(), depth: 1, callSites: 1, text: lineTextAt(stmt) };
    const k = key(row);
    addEdge(edges, k, root.id, row.callSites);
    if (seen.has(k)) continue;
    seen.add(k);
    nodes.set(k, graphNodeFromCaller(row));
    items.push(row);
  }

  items.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line));
  const finished = finish({ command: 'impact', query: address, root: ws.root, engine: 'ts-morph', filesScanned: ws.projectFor(symbol.path).getSourceFiles().length, startedAt, limit: opts.limit }, items);
  return { ...finished, graph: graphForItems({ nodes: [...nodes.values()], edges: [...edges.values()], unresolved: [] }, finished.items) };
}

function key(loc: { path: string; start: { line: number; col: number } }): string {
  return address(loc);
}

function graphNodeFromCaller(caller: Caller): GraphNode {
  return { id: address(caller), path: caller.path, start: caller.start, end: caller.end, kind: caller.kind, name: caller.name, qualifiedName: caller.qualifiedName, depth: caller.depth };
}
