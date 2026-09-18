import { execFileSync } from 'node:child_process';
import { loadGraph, replaceFiles, type LoadReceipt, type RelationshipType, type StoreGraph } from '../store/load.js';
import { metadataFor, writeMetadata, type StoreFormatIdentity } from '../store/meta.js';
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
  stored: 'full' | 'files' | 'none';
  validation: 'off' | 'matched';
}

/** Updates the TS7 snapshot, conservatively re-walks the union, then writes only changed file records. */
export function refreshIndex(root: string, program: Ts7Host, projects: ConfiguredProjects, store: Store, previous: BuiltIndex, options: RefreshOptions, identity?: StoreFormatIdentity): RefreshResult {
  const started = performance.now();
  // The update carries a rewritten config's new text, so it must precede the rediscovery that reads membership from it.
  program.update({ fileChanges: options.fileChanges });
  if (options.full) projects.reload();
  const candidate = indexGraph(root, program, projects);
  const graph = storeGraph(candidate);
  const changedFiles = differingFiles(previous, candidate);
  let stored: RefreshResult['stored'] = 'none';
  if (options.full && changedFiles.length > 0) {
    loadGraph(store, graph);
    stored = 'full';
  } else if (changedFiles.length > 0) {
    replaceFiles(store, changedFiles, fileGraph(graph, changedFiles));
    stored = 'files';
  }
  const durationMs = performance.now() - started;
  writeMetadata(store.path, metadataFor(root, projects, headCommit(root), durationMs, identity));

  let validation: RefreshResult['validation'] = 'off';
  if (options.validate) {
    const verification = indexGraph(root, program, projects);
    if (!graphsEqual(candidate, verification)) throw new Error('Index validation failed: the conservative refresh and full rebuild produced different graphs.');
    validation = 'matched';
  }

  return { built: built(candidate, graph, durationMs), changedFiles, stored, validation };
}

export function graphsEqual(left: HeritageGraph, right: HeritageGraph): boolean {
  return graphFingerprint(storeGraph(left)) === graphFingerprint(storeGraph(right));
}

function indexGraph(root: string, program: Ts7Host, projects: ConfiguredProjects): HeritageGraph {
  return addHeritage(root, program, projects, walkIndex(root, program, projects));
}

function differingFiles(previous: BuiltIndex, next: HeritageGraph): string[] {
  const previousHeritage = heritageByFile(previous.graph, previous.heritage);
  const nextHeritage = heritageByFile(next.graph, next.relationships);
  const files = new Set([...previous.graph.files.keys(), ...next.graph.files.keys()]);
  return [...files].filter((file) => fileFingerprint(previous.graph, previousHeritage.get(file) ?? [], file) !== fileFingerprint(next.graph, nextHeritage.get(file) ?? [], file)).sort();
}

export function fileFingerprint(graph: BuiltIndex['graph'], heritage: readonly HeritageGraph['relationships'][number][], file: string): string {
  const record = graph.files.get(file);
  const declarations = [...new Set(record?.declarations ?? [])].flatMap((key) => {
    const declaration = graph.declarations.get(key);
    return declaration === undefined ? [] : [declaration];
  });
  return `{"declarations":[${serializedRows(declarations).join(',')}],"relationships":[${serializedRows([...(record?.relationships ?? []), ...heritage]).join(',')}]}`;
}

function heritageByFile(graph: BuiltIndex['graph'], heritage: readonly HeritageGraph['relationships'][number][]): Map<string, HeritageGraph['relationships'][number][]> {
  const filesByDeclaration = new Map<string, string[]>();
  for (const [file, record] of graph.files) for (const key of record.declarations) (filesByDeclaration.get(key) ?? filesByDeclaration.set(key, []).get(key)!).push(file);
  const grouped = new Map<string, HeritageGraph['relationships'][number][]>();
  for (const relationship of heritage) for (const file of filesByDeclaration.get(relationship.from) ?? []) (grouped.get(file) ?? grouped.set(file, []).get(file)!).push(relationship);
  return grouped;
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

export function graphFingerprint(graph: StoreGraph): string {
  const commits = graph.commits === undefined ? '' : `,"commits":[${serializedRows(graph.commits).join(',')}]`;
  return `{"declarations":[${serializedRows(graph.declarations).join(',')}],"externals":[${serializedRows(graph.externals).join(',')}]${commits},"relationships":[${serializedRows(graph.relationships).join(',')}]}`;
}

function serializedRows(rows: readonly object[]): string[] {
  return rows.map((row) => JSON.stringify(row)!).sort((left, right) => left.localeCompare(right));
}

function headCommit(root: string): string {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return 'unknown'; }
}
