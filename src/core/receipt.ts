import type { Engine, Receipt, Result } from './types.js';
import { matchesGlob } from './workspace.js';

export interface PathFilters {
  /** Restrict results to paths matching any glob. */
  in?: string | readonly string[];
  /** Remove results whose paths match any glob. */
  exclude?: string | readonly string[];
}

export interface ReceiptInput extends PathFilters {
  command: string;
  query: string;
  root: string;
  engine: Engine;
  filesScanned: number;
  startedAt: number;
  limit?: number | null;
  unresolved?: number;
}

/** Apply path filters and `limit`, count matched files, and stamp the receipt. */
export function finish<T extends { path: string }>(input: ReceiptInput, all: T[]): Result<T> {
  const filtered = all.filter((item) => matchesPathFilters(item.path, input));
  const limit = input.limit ?? null;
  const truncated = limit !== null && filtered.length > limit;
  const items = truncated ? filtered.slice(0, limit) : filtered;
  const receipt: Receipt = {
    command: input.command,
    query: input.query,
    root: input.root,
    files_scanned: input.filesScanned,
    files_matched: new Set(items.map((i) => i.path)).size,
    items: items.length,
    truncated,
    limit,
    engine: input.engine,
    elapsed_ms: Math.round(performance.now() - input.startedAt),
    excluded: all.length - filtered.length,
    unresolved: input.unresolved ?? 0,
  };
  return { items, receipt };
}

export function matchesPathFilters(path: string, filters: PathFilters): boolean {
  const included = globs(filters.in);
  const excluded = globs(filters.exclude);
  return (included.length === 0 || included.some((glob) => matchesGlob(path, glob))) && !excluded.some((glob) => matchesGlob(path, glob));
}

function globs(value: string | readonly string[] | undefined): readonly string[] {
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}

export function formatReceipt(r: Receipt): string {
  const cut = r.truncated ? `, truncated at ${r.limit}` : '';
  const excluded = r.excluded > 0 ? `, ${r.excluded} excluded` : '';
  const unresolved = r.unresolved > 0 ? `, ${r.unresolved} unresolved` : '';
  return `ast: ${r.items} items in ${r.files_matched} files (scanned ${r.files_scanned}, ${r.engine}, ${(r.elapsed_ms / 1000).toFixed(1)}s${cut}${excluded}${unresolved})`;
}
