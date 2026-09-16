import { findInFiles, Lang } from '@ast-grep/napi';
import type { PathFilters } from './receipt.js';
import { langFor, matchesGlob, type Workspace } from './workspace.js';

export interface SearchOptions extends PathFilters {
  limit?: number | null;
}

export interface SearchMatch {
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  text: string;
}

export interface SearchResult {
  items: SearchMatch[];
  receipt: { elapsed_ms: number; excluded: number; truncated: boolean; limit: number | null };
}

/** Structural syntax search that stays outside the TypeScript resident. */
export async function search(ws: Workspace, pattern: string, opts: SearchOptions = {}): Promise<SearchResult> {
  const startedAt = performance.now();
  const byLang = new Map<Lang, string[]>();
  for (const file of ws.files()) {
    const lang = langFor(file);
    if (lang !== null) (byLang.get(lang) ?? byLang.set(lang, []).get(lang)!).push(ws.abs(file));
  }
  const matches: SearchMatch[] = [];
  for (const [lang, paths] of byLang) {
    let seen = 0;
    const count = await findInFiles(lang, { paths, matcher: { rule: { pattern } } }, (error, nodes) => {
      seen++;
      if (error) return;
      for (const node of nodes) {
        const range = node.range();
        matches.push({
          path: ws.rel(node.getRoot().filename()),
          start: { line: range.start.line + 1, col: range.start.column + 1 },
          end: { line: range.end.line + 1, col: range.end.column + 1 },
          text: node.text().split('\n', 1)[0]?.trim() ?? '',
        });
      }
    });
    await drained(() => seen >= count);
  }
  matches.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line || a.start.col - b.start.col));
  const filtered = matches.filter((match) => matchesPathFilters(match.path, opts));
  const limit = opts.limit ?? null;
  const truncated = limit !== null && filtered.length > limit;
  return { items: truncated ? filtered.slice(0, limit) : filtered, receipt: { elapsed_ms: Math.round(performance.now() - startedAt), excluded: matches.length - filtered.length, truncated, limit } };
}

function matchesPathFilters(file: string, filters: PathFilters): boolean {
  const included = values(filters.in);
  const excluded = values(filters.exclude);
  return (included.length === 0 || included.some((glob) => matchesGlob(file, glob))) && !excluded.some((glob) => matchesGlob(file, glob));
}

function values(value: string | readonly string[] | undefined): readonly string[] { return value === undefined ? [] : typeof value === 'string' ? [value] : value; }

async function drained(done: () => boolean): Promise<void> {
  while (!done()) await new Promise<void>((resolve) => setImmediate(resolve));
}
