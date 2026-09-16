import { loadGraph, type DeclarationRow, type LoadReceipt, type RelationshipRow, type StoreGraph } from '../store/load.js';
import { Store } from '../store/store.js';
import { Ts7Host } from '../ts7/api.js';
import { ConfiguredProjects } from '../ts7/projects.js';
import type { DeclarationNode, IndexGraph, IndexRelationship } from './graph.js';
import { addHeritage, type HeritageGraph } from './heritage.js';
import { walkIndex } from './walk.js';

export interface BuildReceipt extends LoadReceipt {
  internalSites: number;
  unresolvedOccurrences: number;
  dispatchCalls: number;
  durationMs: number;
}

export interface BuiltIndex {
  graph: IndexGraph;
  heritage: HeritageGraph['relationships'];
  receipt: BuildReceipt;
}

/** Walks the configured project union, adds heritage facts, and atomically replaces the persisted graph. */
export function buildIndex(root: string, program: Ts7Host, projects: ConfiguredProjects, store: Store): BuiltIndex {
  const started = performance.now();
  const walked = walkIndex(root, program, projects);
  const enriched = addHeritage(root, program, projects, walked);
  const loaded = loadGraph(store, storeGraph(enriched));
  return {
    graph: enriched.graph,
    heritage: enriched.relationships,
    receipt: {
      ...loaded,
      internalSites: enriched.graph.internalSites,
      unresolvedOccurrences: enriched.graph.unresolvedOccurrences,
      dispatchCalls: enriched.dispatchCalls,
      durationMs: performance.now() - started,
    },
  };
}

export function storeGraph(index: HeritageGraph): StoreGraph {
  return {
    declarations: [...index.graph.declarations.values()].map(declarationRow),
    externals: [...index.graph.externals.values()],
    relationships: [
      ...index.graph.relationships.map((relationship) => relationshipRow(relationship, index.graph)), 
      ...index.relationships.map((relationship) => ({ ...relationship, target: 'Declaration' as const })),
    ],
  };
}

function declarationRow(node: DeclarationNode): DeclarationRow {
  return { ...node, container: node.container };
}

function relationshipRow(relationship: IndexRelationship, graph: IndexGraph): RelationshipRow {
  return { ...relationship, target: graph.externals.has(relationship.to) ? 'External' : 'Declaration' };
}
