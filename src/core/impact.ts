import { Node } from 'ts-morph';
import { callersOf } from './callers.js';
import { finish } from './receipt.js';
import { resolveSymbol, type ResolveOptions } from './symbols.js';
import { lineTextAt, locOf, nameIdentifier, referencesTo, type NameNode } from './ts-program.js';
import type { Caller, Result } from './types.js';
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

  const seen = new Set<string>([key(locOf(ws, rootId))]);
  const items: Caller[] = [];
  let frontier: NameNode[] = [rootId];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: NameNode[] = [];
    for (const id of frontier) {
      for (const caller of callersOf(ws, id, depth)) {
        const k = key(caller);
        if (seen.has(k)) continue;
        seen.add(k);
        const { id: callerId, ...row } = caller;
        items.push(row);
        if (callerId) next.push(callerId);
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
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(row);
  }

  items.sort((a, b) => a.depth - b.depth || (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line));
  return finish({ command: 'impact', query: address, root: ws.root, engine: 'ts-morph', filesScanned: ws.project().getSourceFiles().length, startedAt, limit: opts.limit }, items);
}

function key(loc: { path: string; start: { line: number; col: number } }): string {
  return `${loc.path}:${loc.start.line}:${loc.start.col}`;
}
