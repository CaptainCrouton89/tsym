import type { DeclarationRecord } from '../core/declarations.js';

export type Direction = 'calls' | 'callers';
export type EdgeKind = 'call' | 'impl';
export type UnresolvedReason = 'dispatch' | 'dynamic' | 'external';

export interface GraphNode {
  id: string;
  path: string;
  start: { line: number; col: number };
  end: { line: number; col: number };
  kind: string;
  name: string;
  qualifiedName: string;
  depth: number;
  connecting?: true;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
  siteIds: readonly string[];
  callSites: number;
}

export interface UnresolvedSite {
  from: string;
  siteId: string;
  name: string;
  reason: UnresolvedReason;
  path: string;
  start: { line: number; col: number };
  text: string;
  dispatch: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedSite[];
}

export interface RelationRow extends GraphNode {
  callSites: number;
  edgeKinds: readonly EdgeKind[];
}

export interface TraversalResult {
  graph: Graph;
  rows: RelationRow[];
  excluded: number;
  unresolved: number;
  dispatch: number;
}

export function nodeFor(record: DeclarationRecord, depth: number): GraphNode {
  return {
    id: record.address,
    path: record.location.path,
    start: { line: record.location.line, col: record.location.col },
    end: { line: record.location.line, col: record.location.col },
    kind: record.kind,
    name: record.name,
    qualifiedName: record.qualifiedName,
    depth,
  };
}
