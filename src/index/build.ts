import { execFileSync } from 'node:child_process';
import { loadGraph, readGraph, type DeclarationRow, type LoadReceipt, type RelationshipRow, type StoreGraph } from '../store/load.js';
import { metadataFor, writeMetadata } from '../store/meta.js';
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
  writeMetadata(store.path, metadataFor(root, projects, headCommit(root)));
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

/** Rehydrates an unchanged persisted graph without re-walking the TypeScript program. */
export function reuseIndex(store: Store): BuiltIndex {
  const persisted = readGraph(store);
  const declarations = new Map(persisted.declarations.map((declaration) => [declaration.key, declaration as DeclarationNode]));
  const externals = new Map(persisted.externals.map((external) => [external.key, external]));
  const relationships = persisted.relationships.filter((relationship) => ['CONTAINS', 'REFERENCES', 'CALLS', 'TYPE_MENTION', 'IMPORTS', 'EXPORTS'].includes(relationship.type)).map(({ target: _target, ...relationship }) => relationship as IndexRelationship);
  const heritage = persisted.relationships.filter((relationship) => relationship.type === 'IMPLEMENTS' || relationship.type === 'EXTENDS').map(({ target: _target, ...relationship }) => relationship) as HeritageGraph['relationships'];
  const files = new Map<string, { declarations: string[]; relationships: IndexRelationship[] }>();
  for (const declaration of declarations.values()) files.set(declaration.file, { declarations: [], relationships: [] });
  for (const declaration of declarations.values()) files.get(declaration.file)!.declarations.push(declaration.key);
  for (const relationship of relationships) {
    const owner = declarations.get(relationship.from);
    if (owner) files.get(owner.file)!.relationships.push(relationship);
  }
  const counts = Object.fromEntries(['CONTAINS', 'REFERENCES', 'CALLS', 'IMPLEMENTS', 'EXTENDS', 'TYPE_MENTION', 'IMPORTS', 'EXPORTS', 'CHANGED', 'RENAMED_FROM'].map((type) => [type, 0])) as LoadReceipt['relationships'];
  for (const relationship of persisted.relationships) counts[relationship.type]++;
  return {
    graph: { declarations, externals, files, relationships, internalSites: 0, unresolvedOccurrences: 0 },
    heritage,
    receipt: { declarations: persisted.declarations.length, externals: persisted.externals.length, commits: persisted.commits?.length ?? 0, relationships: counts, internalSites: 0, unresolvedOccurrences: 0, dispatchCalls: persisted.relationships.filter((relationship) => relationship.type === 'CALLS' && relationship.dispatch === true).length, durationMs: 0 },
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

function headCommit(root: string): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'unknown'; }
}
