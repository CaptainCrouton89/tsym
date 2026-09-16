import { execFileSync } from 'node:child_process';
import { loadGraph, replaceFiles, type LoadReceipt, type RelationshipType, type StoreGraph } from '../store/load.js';
import { metadataFor, writeMetadata } from '../store/meta.js';
import { Store } from '../store/store.js';
import { Ts7Host } from '../ts7/api.js';
import { ConfiguredProjects } from '../ts7/projects.js';
import { addHeritage, type HeritageGraph } from './heritage.js';
import { storeGraph, type BuildReceipt, type BuiltIndex } from './build.js';
import { walkIndex } from './walk.js';

export interface RefreshOptions {
  fileChanges: { changed?: string[]; created?: string[]; deleted?: string[] } | { invalidateAll: true };
  full?: boolean;
  validate?: boolean;
}

export interface RefreshResult {
  built: BuiltIndex;
  changedFiles: readonly string[];
  full: boolean;
  validation: 'off' | 'matched';
}

/** Updates the TS7 snapshot, conservatively re-walks the union, then writes only changed file records. */
export function refreshIndex(root: string, program: Ts7Host, projects: ConfiguredProjects, store: Store, previous: BuiltIndex, options: RefreshOptions): RefreshResult {
  const started = performance.now();
  // The update carries a rewritten config's new text, so it must precede the rediscovery that reads membership from it.
  program.update({ fileChanges: options.fileChanges });
  if (options.full) projects.reload();
  const candidate = indexGraph(root, program, projects);
  const graph = storeGraph(candidate);
  const changedFiles = differingFiles(previous, candidate);
  const full = options.full === true;
  if (full) loadGraph(store, graph);
  else if (changedFiles.length > 0) replaceFiles(store, changedFiles, fileGraph(graph, changedFiles));
  const durationMs = performance.now() - started;
  writeMetadata(store.path, metadataFor(root, projects, headCommit(root), durationMs));

  let validation: RefreshResult['validation'] = 'off';
  if (options.validate) {
    const verification = indexGraph(root, program, projects);
    if (!graphsEqual(candidate, verification)) throw new Error('Index validation failed: the conservative refresh and full rebuild produced different graphs.');
    validation = 'matched';
  }

  return { built: built(candidate, graph, durationMs), changedFiles, full, validation };
}

export function graphsEqual(left: HeritageGraph, right: HeritageGraph): boolean {
  return JSON.stringify(normalize(storeGraph(left))) === JSON.stringify(normalize(storeGraph(right)));
}

function indexGraph(root: string, program: Ts7Host, projects: ConfiguredProjects): HeritageGraph {
  return addHeritage(root, program, projects, walkIndex(root, program, projects));
}

function differingFiles(previous: BuiltIndex, next: HeritageGraph): string[] {
  const files = new Set([...previous.graph.files.keys(), ...next.graph.files.keys()]);
  return [...files].filter((file) => fileFingerprint(previous.graph, previous.heritage, file) !== fileFingerprint(next.graph, next.relationships, file)).sort();
}

function fileFingerprint(graph: BuiltIndex['graph'], heritage: readonly HeritageGraph['relationships'][number][], file: string): string {
  const record = graph.files.get(file);
  const keys = new Set(record?.declarations ?? []);
  const declarations = [...keys].map((key) => graph.declarations.get(key)).filter(Boolean).sort(byJson);
  const relationships = [...(record?.relationships ?? []), ...heritage.filter((relationship) => keys.has(relationship.from))].sort(byJson);
  return JSON.stringify({ declarations, relationships });
}

function fileGraph(graph: StoreGraph, files: readonly string[]): StoreGraph {
  const replaced = new Set(files);
  const declarations = graph.declarations.filter((declaration) => replaced.has(declaration.file));
  const keys = new Set(declarations.map((declaration) => declaration.key));
  const relationships = graph.relationships.filter((relationship) => keys.has(relationship.from) || keys.has(relationship.to));
  const externalKeys = new Set(relationships.filter((relationship) => relationship.target === 'External').map((relationship) => relationship.to));
  return { declarations, externals: graph.externals.filter((external) => externalKeys.has(external.key)), relationships };
}

function built(index: HeritageGraph, graph: StoreGraph, durationMs: number): BuiltIndex {
  const receipt = receiptFor(graph);
  return {
    graph: index.graph,
    heritage: index.relationships,
    receipt: {
      ...receipt,
      internalSites: index.graph.internalSites,
      unresolvedOccurrences: index.graph.unresolvedOccurrences,
      dispatchCalls: index.dispatchCalls,
      durationMs,
    },
  };
}

function receiptFor(graph: StoreGraph): LoadReceipt {
  const relationships = Object.fromEntries(['CONTAINS', 'REFERENCES', 'CALLS', 'IMPLEMENTS', 'EXTENDS', 'TYPE_MENTION', 'IMPORTS', 'EXPORTS', 'CHANGED', 'RENAMED_FROM'].map((type) => [type, 0])) as Record<RelationshipType, number>;
  for (const relationship of graph.relationships) relationships[relationship.type]++;
  return { declarations: graph.declarations.length, externals: graph.externals.length, commits: graph.commits?.length ?? 0, relationships };
}

function normalize(graph: StoreGraph): StoreGraph {
  return {
    declarations: [...graph.declarations].sort(byJson),
    externals: [...graph.externals].sort(byJson),
    commits: graph.commits === undefined ? undefined : [...graph.commits].sort(byJson),
    relationships: [...graph.relationships].sort(byJson),
  };
}

function byJson<T>(left: T, right: T): number { return JSON.stringify(left).localeCompare(JSON.stringify(right)); }

function headCommit(root: string): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'unknown'; }
}
