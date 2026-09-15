import { callers, type CallersOptions } from './core/callers.js';
import { find, type FindOptions } from './core/find.js';
import { impact, type ImpactOptions } from './core/impact.js';
import { outline } from './core/outline.js';
import { refs, type RefsOptions } from './core/refs.js';
import { search, type SearchOptions } from './core/search.js';
import { show } from './core/show.js';
import { type ResolveOptions } from './core/symbols.js';
import type { Caller, Excerpt, Match, Ref, Result, Symbol } from './core/types.js';
import { openWorkspace as open, type Workspace } from './core/workspace.js';

export type { Caller, Engine, Excerpt, Loc, Match, Pos, Receipt, Ref, Result, Symbol, SymbolKind } from './core/types.js';
export type { CallersOptions, FindOptions, ImpactOptions, RefsOptions, ResolveOptions, SearchOptions, Workspace };
export { AmbiguousSymbol, SymbolNotFound, formatAddress } from './core/symbols.js';
export { formatReceipt } from './core/receipt.js';
export { SYMBOL_KINDS } from './core/types.js';

/** The seven read operations over one workspace. ts-morph's program is built on the first refs/callers/impact call and kept. */
export interface Ast {
  readonly workspace: Workspace;
  outline(file: string): Result<Symbol>;
  find(query: string, opts?: FindOptions): Promise<Result<Symbol>>;
  show(symbol: string, opts?: ResolveOptions): Promise<Result<Excerpt>>;
  search(pattern: string, opts?: SearchOptions): Promise<Result<Match>>;
  refs(symbol: string, opts?: RefsOptions): Promise<Result<Ref>>;
  callers(symbol: string, opts?: CallersOptions): Promise<Result<Caller>>;
  impact(symbol: string, opts?: ImpactOptions): Promise<Result<Caller>>;
}

/**
 * Open the workspace containing `dir` (nearest tsconfig.json, else package.json, else .git). Nothing is parsed until a method runs.
 */
export function openWorkspace(dir: string = process.cwd()): Ast {
  const ws = open(dir);
  return {
    workspace: ws,
    outline: (file) => outline(ws, file),
    find: (query, opts) => find(ws, query, opts),
    show: (symbol, opts) => show(ws, symbol, opts),
    search: (pattern, opts) => search(ws, pattern, opts),
    refs: (symbol, opts) => refs(ws, symbol, opts),
    callers: (symbol, opts) => callers(ws, symbol, opts),
    impact: (symbol, opts) => impact(ws, symbol, opts),
  };
}
