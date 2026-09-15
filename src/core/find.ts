import { parseFiles, type SgRoot } from '@ast-grep/napi';
import { outlineRoot } from './outline.js';
import { finish, type PathFilters } from './receipt.js';
import type { Result, Symbol, SymbolKind } from './types.js';
import { langFor, type Workspace } from './workspace.js';

export interface FindOptions extends PathFilters {
  /** Restrict to one declaration kind. */
  kind?: SymbolKind;
  limit?: number | null;
}

/**
 * Where a symbol is declared. `query` is a name (`reviveNode`), a member (`Broker.start`),
 * or a glob over names (`handle*`, `Broker.*`).
 */
export async function find(ws: Workspace, query: string, opts: FindOptions = {}): Promise<Result<Symbol>> {
  const startedAt = performance.now();
  const files = ws.files();
  const matches = matcherFor(query);
  const found: Symbol[] = [];
  const scanned = await parseAll(ws, files, (root, rel) => {
    for (const sym of outlineRoot(root, rel)) {
      if (opts.kind && sym.kind !== opts.kind) continue;
      if (matches(sym)) found.push(sym);
    }
  });
  found.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line));
  return finish({ command: 'find', query, root: ws.root, engine: 'ast-grep', filesScanned: scanned, startedAt, limit: opts.limit, ...opts }, found);
}

/** Parse every file in parallel (Rust threads); the callback runs per file on the JS thread. */
export async function parseAll(ws: Workspace, files: string[], onFile: (root: SgRoot, rel: string) => void): Promise<number> {
  const paths = files.filter((f) => langFor(f) !== null).map((f) => ws.abs(f));
  if (paths.length === 0) return 0;
  const pending: Array<{ root: SgRoot; rel: string }> = [];
  let seen = 0;
  const count = await parseFiles(paths, (err, root) => {
    seen += 1;
    if (err) return;
    pending.push({ root, rel: ws.rel(root.filename()) });
  });
  await drained(() => seen >= count);
  for (const p of pending) onFile(p.root, p.rel);
  return count;
}

/**
 * ast-grep resolves parseFiles/findInFiles when its Rust side finishes, but the per-file JS callbacks
 * are queued through a threadsafe function and can still be pending. Yield until they have all run.
 */
export async function drained(done: () => boolean): Promise<void> {
  while (!done()) await new Promise<void>((resolve) => setImmediate(resolve));
}

function matcherFor(query: string): (s: Symbol) => boolean {
  const qualified = query.includes('.');
  const re = globToRegExp(query);
  return (s) => re.test(qualified ? s.qualifiedName : s.name);
}

function globToRegExp(glob: string): RegExp {
  const src = glob
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${src}$`);
}
