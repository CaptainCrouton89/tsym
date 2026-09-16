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
  kind: SymbolKind | 'module' | 'export';
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

/** One function or method called by the symbol. The loc is the callee's declaration. */
export interface Callee extends Loc {
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  /** 1 for a direct callee; larger for transitive callees from `trace`. */
  depth: number;
  callSites: number;
  text: string;
}

export interface GraphNode {
  /** `path:line:col` of the declaration — a valid ast symbol address. */
  id: string;
  path: string;
  start: Pos;
  end: Pos;
  kind: Symbol['kind'];
  name: string;
  qualifiedName: string;
  /** 0 for a seed. */
  depth: number;
  /** True when this node only connects a seed to a returned row. */
  connecting?: true;
}

export interface GraphEdge {
  from: string;
  to: string;
  callSites: number;
}

/** A call site the traversal saw but could not follow. */
export interface UnresolvedEdge {
  from: string;
  /** Callee text as written at the call site. */
  name: string;
  reason: 'dispatch' | 'dynamic' | 'external';
  path: string;
  start: Pos;
  text: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedEdge[];
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
  /** Rows removed by --in/--exclude. */
  excluded: number;
  /** Call sites seen but not followed (external + dispatch + dynamic). */
  unresolved: number;
}

export interface Result<T> {
  items: T[];
  receipt: Receipt;
  /** Present only on traversal results. */
  graph?: Graph;
}
