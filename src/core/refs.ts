import { Node } from 'ts-morph';
import { finish, type PathFilters } from './receipt.js';
import { asAddresses, resolveSymbol, uniqueSymbols, type ResolveOptions } from './symbols.js';
import { lineTextAt, locOf, nameIdentifier, referencesTo } from './ts-program.js';
import type { Ref, Result } from './types.js';
import type { Workspace } from './workspace.js';

export interface RefsOptions extends ResolveOptions, PathFilters {
  limit?: number | null;
}

/** Every reference to one or more symbols across the program, excluding their declarations. */
export async function refs(ws: Workspace, addresses: string | readonly string[], opts: RefsOptions = {}): Promise<Result<Ref>> {
  const startedAt = performance.now();
  const inputs = asAddresses(addresses);
  const symbols = await Promise.all(inputs.map((address) => resolveSymbol(ws, address, opts)));
  const byKey = new Map<string, Ref>();
  for (const symbol of uniqueSymbols(symbols)) {
    const id = nameIdentifier(ws, symbol);
    for (const ref of referencesTo(id)) {
      const node = ref.getNode();
      const parent = node.getParent();
      const isImport = !!parent && (Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent) || Node.isExportSpecifier(parent));
      const item = { ...locOf(ws, node), text: lineTextAt(node), write: ref.isWriteAccess() && !isImport };
      byKey.set(key(item), item);
    }
  }
  const items = [...byKey.values()].sort(compareRefs);
  return finish({ command: 'refs', query: inputs.join(' '), root: ws.root, engine: 'ts-morph', filesScanned: Math.max(...symbols.map((symbol) => ws.projectFor(symbol.path).getSourceFiles().length)), startedAt, limit: opts.limit, ...opts }, items);
}


function key(loc: { path: string; start: { line: number; col: number } }): string {
  return `${loc.path}:${loc.start.line}:${loc.start.col}`;
}

function compareRefs(a: Ref, b: Ref): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line || a.start.col - b.start.col;
}
