/** 1-based line and column. */
export interface Pos {
  line: number;
  col: number;
}

/** A span of source in one file. `path` is relative to the workspace root. */
export interface Loc {
  path: string;
  start: Pos;
  end: Pos;
}

export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'property'
  | 'interface'
  | 'type'
  | 'enum'
  | 'namespace'
  | 'var';

export const SYMBOL_KINDS: readonly SymbolKind[] = [
  'function',
  'class',
  'method',
  'property',
  'interface',
  'type',
  'enum',
  'namespace',
  'var',
];

/** A declaration. `text` is its first source line, trimmed. */
export interface Symbol extends Loc {
  kind: SymbolKind;
  name: string;
  /** `Outer.member` for members, else the same as `name`. */
  qualifiedName: string;
  exported: boolean;
  text: string;
  /** Position of the name identifier — the position `refs`/`callers` resolve from. */
  namePos: Pos;
}

/** A declaration's full source, including its leading doc comment when one is attached. */
export interface Excerpt extends Loc {
  symbol: Symbol;
  source: string;
}

/** One structural-pattern match. `text` is the first line of the matched node, trimmed. */
export interface Match extends Loc {
  text: string;
}

/** One reference site. `text` is the containing source line, trimmed. */
export interface Ref extends Loc {
  text: string;
  write: boolean;
}

/** One function or method that calls the symbol. The loc is the caller's declaration. */
export interface Caller extends Loc {
  kind: SymbolKind | 'module' | 'export';
  name: string;
  qualifiedName: string;
  /** 1 for a direct caller; larger for transitive callers from `impact`. */
  depth: number;
  callSites: number;
  text: string;
}

export type Engine = 'ast-grep' | 'ts-morph';

export interface Receipt {
  command: string;
  query: string;
  root: string;
  files_scanned: number;
  files_matched: number;
  items: number;
  truncated: boolean;
  limit: number | null;
  engine: Engine;
  elapsed_ms: number;
}

export interface Result<T> {
  items: T[];
  receipt: Receipt;
}
