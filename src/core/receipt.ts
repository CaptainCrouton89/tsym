import { matchesGlob } from './workspace.js';

export interface PathFilters {
  /** Restrict results to paths matching any glob. */
  in?: string | readonly string[];
  /** Remove results whose paths match any glob. */
  exclude?: string | readonly string[];
}

export function matchesPathFilters(path: string, filters: PathFilters): boolean {
  const included = globs(filters.in);
  const excluded = globs(filters.exclude);
  return (included.length === 0 || included.some((glob) => matchesGlob(path, glob))) && !excluded.some((glob) => matchesGlob(path, glob));
}

function globs(value: string | readonly string[] | undefined): readonly string[] {
  return value === undefined ? [] : typeof value === 'string' ? [value] : value;
}
