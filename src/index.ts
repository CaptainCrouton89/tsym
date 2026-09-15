import { callers, type CallersOptions } from './core/callers.js';
import { calls, type CallsOptions } from './core/calls.js';
import { find, type FindOptions } from './core/find.js';
import { impact, type ImpactOptions } from './core/impact.js';
import { outline, type OutlineOptions } from './core/outline.js';
import { refs, type RefsOptions } from './core/refs.js';
import { search, type SearchOptions } from './core/search.js';
import { show, type ShowOptions } from './core/show.js';
import { type ResolveOptions } from './core/symbols.js';
import { trace, type TraceOptions } from './core/trace.js';
import type { Callee, Caller, Excerpt, Match, Ref, Result, Symbol } from './core/types.js';
import { openWorkspace as open, type Workspace } from './core/workspace.js';

export type { Callee, Caller, Engine, Excerpt, Graph, GraphEdge, GraphNode, Loc, Match, Pos, Receipt, Ref, Result, Symbol, SymbolKind, UnresolvedEdge } from './core/types.js';
export type { CallersOptions, CallsOptions, FindOptions, ImpactOptions, OutlineOptions, RefsOptions, ResolveOptions, SearchOptions, ShowOptions, TraceOptions, Workspace };
export { AmbiguousSymbol, EmptySymbolList, SymbolNotFound, formatAddress } from './core/symbols.js';
export { formatReceipt } from './core/receipt.js';
export { NoProject } from './core/workspace.js';
export { SYMBOL_KINDS } from './core/types.js';

/** The read operations over one workspace. ts-morph's program is built on the first refs/callers/calls/impact/trace call and kept. */
export interface Ast {
  readonly workspace: Workspace;
  outline(file: string, opts?: OutlineOptions): Result<Symbol>;
  find(query: string, opts?: FindOptions): Promise<Result<Symbol>>;
  show(symbol: string, opts?: ShowOptions): Promise<Result<Excerpt>>;
  search(pattern: string, opts?: SearchOptions): Promise<Result<Match>>;
  refs(symbols: string | readonly string[], opts?: RefsOptions): Promise<Result<Ref>>;
  callers(symbols: string | readonly string[], opts?: CallersOptions): Promise<Result<Caller>>;
  calls(symbols: string | readonly string[], opts?: CallsOptions): Promise<Result<Callee>>;
  impact(symbols: string | readonly string[], opts?: ImpactOptions): Promise<Result<Caller>>;
  trace(symbols: string | readonly string[], opts?: TraceOptions): Promise<Result<Callee>>;
}

/**
 * Open the workspace containing `dir` (nearest tsconfig.json, else package.json, else .git). Nothing is parsed until a method runs.
 */
export function openWorkspace(dir: string = process.cwd()): Ast {
  const ws = open(dir);
  return {
    workspace: ws,
    outline: (file, opts) => outline(ws, file, opts),
    find: (query, opts) => find(ws, query, opts),
    show: (symbol, opts) => show(ws, symbol, opts),
    search: (pattern, opts) => search(ws, pattern, opts),
    refs: (symbol, opts) => refs(ws, symbol, opts),
    callers: (symbol, opts) => callers(ws, symbol, opts),
    calls: (symbol, opts) => calls(ws, symbol, opts),
    impact: (symbol, opts) => impact(ws, symbol, opts),
    trace: (symbol, opts) => trace(ws, symbol, opts),
  };
}
