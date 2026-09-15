import { findInFiles, Lang } from '@ast-grep/napi';
import { drained } from './find.js';
import { firstLine } from './outline.js';
import { finish, type PathFilters } from './receipt.js';
import type { Match, Result } from './types.js';
import { langFor, type Workspace } from './workspace.js';

export interface SearchOptions extends PathFilters {
  limit?: number | null;
}

/**
 * Structural pattern search. `pattern` is ast-grep syntax: `$A` matches one node,
 * `$$$ARGS` matches a sequence — e.g. `await $FN($$$ARGS)` or `new Project($$$)`.
 */
export async function search(ws: Workspace, pattern: string, opts: SearchOptions = {}): Promise<Result<Match>> {
  const startedAt = performance.now();
  const byLang = new Map<Lang, string[]>();
  for (const f of ws.files()) {
    const lang = langFor(f);
    if (lang === null) continue;
    (byLang.get(lang) ?? byLang.set(lang, []).get(lang)!).push(ws.abs(f));
  }
  const matches: Match[] = [];
  let scanned = 0;
  for (const [lang, paths] of byLang) {
    let seen = 0;
    const count = await findInFiles(lang, { paths, matcher: { rule: { pattern } } }, (err, nodes) => {
      seen += 1;
      if (err) return;
      for (const n of nodes) {
        const r = n.range();
        matches.push({
          path: ws.rel(n.getRoot().filename()),
          start: { line: r.start.line + 1, col: r.start.column + 1 },
          end: { line: r.end.line + 1, col: r.end.column + 1 },
          text: firstLine(n),
        });
      }
    });
    await drained(() => seen >= count);
    scanned += paths.length;
  }
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line || a.start.col - b.start.col));
  return finish({ command: 'search', query: pattern, root: ws.root, engine: 'ast-grep', filesScanned: scanned, startedAt, limit: opts.limit, ...opts }, matches);
}
