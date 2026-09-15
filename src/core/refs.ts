import { Node } from 'ts-morph';
import { finish } from './receipt.js';
import { resolveSymbol, type ResolveOptions } from './symbols.js';
import { lineTextAt, locOf, nameIdentifier, referencesTo } from './ts-program.js';
import type { Ref, Result } from './types.js';
import type { Workspace } from './workspace.js';

export interface RefsOptions extends ResolveOptions {
  limit?: number | null;
}

/** Every reference to a symbol across the program, excluding its declaration. */
export async function refs(ws: Workspace, address: string, opts: RefsOptions = {}): Promise<Result<Ref>> {
  const startedAt = performance.now();
  const symbol = await resolveSymbol(ws, address, opts);
  const id = nameIdentifier(ws, symbol);
  const items: Ref[] = referencesTo(id).map((ref) => {
    const node = ref.getNode();
    const parent = node.getParent();
    const isImport = !!parent && (Node.isImportSpecifier(parent) || Node.isImportClause(parent) || Node.isNamespaceImport(parent) || Node.isExportSpecifier(parent));
    return { ...locOf(ws, node), text: lineTextAt(node), write: ref.isWriteAccess() && !isImport };
  });
  items.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line || a.start.col - b.start.col));
  return finish({ command: 'refs', query: address, root: ws.root, engine: 'ts-morph', filesScanned: ws.project().getSourceFiles().length, startedAt, limit: opts.limit }, items);
}
