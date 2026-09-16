import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Store } from './store.js';

export interface DeclarationRow {
  key: string;
  at: string;
  name: string;
  qname: string;
  kind: string;
  exported: boolean;
  file: string;
  dir: string;
  top: string;
  line: number;
  col: number;
  endLine: number;
  lines: number;
  declCount: number;
  container: string | null;
}

export interface ExternalRow { key: string; module: string; name: string; }
export interface CommitRow { hash: string; ts: string; author: string; subject: string; }

export type RelationshipType = 'CONTAINS' | 'REFERENCES' | 'CALLS' | 'IMPLEMENTS' | 'EXTENDS' | 'TYPE_MENTION' | 'IMPORTS' | 'EXPORTS' | 'CHANGED' | 'RENAMED_FROM';
export type RelationshipTarget = 'Declaration' | 'External';

export interface RelationshipRow {
  type: RelationshipType;
  from: string;
  to: string;
  target: RelationshipTarget;
  line?: number;
  col?: number;
  role?: string;
  dispatch?: boolean;
  position?: string;
  names?: string;
  name?: string;
  added?: number;
  removed?: number;
  basis?: 'text-identical' | 'container-renamed' | 'file-moved';
  commit?: string;
}

export interface StoreGraph {
  declarations: readonly DeclarationRow[];
  externals: readonly ExternalRow[];
  commits?: readonly CommitRow[];
  relationships: readonly RelationshipRow[];
}

export interface LoadReceipt {
  declarations: number;
  externals: number;
  commits: number;
  relationships: Record<RelationshipType, number>;
}

const declarationColumns = ['key', 'at', 'name', 'qname', 'kind', 'exported', 'file', 'dir', 'top', 'line', 'col', 'endLine', 'lines', 'declCount', 'container'] as const;
const externalColumns = ['key', 'module', 'name'] as const;
const commitColumns = ['hash', 'ts', 'author', 'subject'] as const;

export function loadGraph(store: Store, graph: StoreGraph): LoadReceipt {
  validateGraph(graph);
  return store.transaction(() => {
    clearGraph(store);
    copyGraph(store, graph);
    return receiptFor(graph);
  });
}

/** Atomically replaces every changed file, so relationships can target declarations created by the same refresh. */
export function replaceFiles(store: Store, files: readonly string[], graph: StoreGraph): LoadReceipt {
  const replaced = new Set(files);
  if (graph.declarations.some((declaration) => !replaced.has(declaration.file))) throw new Error('Replacement graph contains a declaration outside the replaced files.');
  validateGraph(graph);
  return store.transaction(() => {
    for (const file of replaced) store.execute(`MATCH (d:Declaration) WHERE d.file = ${literal(file)} DETACH DELETE d`);
    copyRows(store, 'Declaration', declarationColumns, graph.declarations);
    copyMissingExternals(store, graph.externals);
    copyMissingCommits(store, graph.commits ?? []);
    copyRelationships(store, graph.relationships);
    store.execute('MATCH (e:External) WHERE NOT EXISTS { MATCH (:Declaration)-[]->(e) } DETACH DELETE e');
    return receiptFor(graph);
  });
}

/** One-file compatibility call of the unified replacement transaction. */
export function replaceFile(store: Store, file: string, graph: StoreGraph): LoadReceipt {
  return replaceFiles(store, [file], graph);
}

function clearGraph(store: Store): void {
  store.execute('MATCH (d:Declaration) DETACH DELETE d');
  store.execute('MATCH (e:External) DETACH DELETE e');
  store.execute('MATCH (c:Commit) DETACH DELETE c');
}

function copyGraph(store: Store, graph: StoreGraph): void {
  copyRows(store, 'Declaration', declarationColumns, graph.declarations);
  copyRows(store, 'External', externalColumns, graph.externals);
  copyRows(store, 'Commit', commitColumns, graph.commits ?? []);
  copyRelationships(store, graph.relationships);
}

function copyMissingExternals(store: Store, externals: readonly ExternalRow[]): void {
  const missing = externals.filter((external) => store.execute(`MATCH (e:External) WHERE e.key = ${literal(external.key)} RETURN e.key`).length === 0);
  copyRows(store, 'External', externalColumns, missing);
}

function copyMissingCommits(store: Store, commits: readonly CommitRow[]): void {
  const missing = commits.filter((commit) => store.execute(`MATCH (c:Commit) WHERE c.hash = ${literal(commit.hash)} RETURN c.hash`).length === 0);
  copyRows(store, 'Commit', commitColumns, missing);
}

function copyRelationships(store: Store, relationships: readonly RelationshipRow[]): void {
  for (const type of relationshipTypes) {
    for (const target of relationshipTargets(type)) {
      const rows = relationships.filter((relationship) => relationship.type === type && relationship.target === target);
      if (rows.length === 0) continue;
      copyRows(store, type, relationshipColumns(type), rows, relationshipTargets(type).length === 1 ? undefined : target);
    }
  }
}

function copyRows(store: Store, table: string, columns: readonly string[], rows: readonly object[], target?: RelationshipTarget): void {
  if (rows.length === 0) return;
  const directory = mkdtempSync(path.join(tmpdir(), 'tsym-store-'));
  const csvPath = path.join(directory, `${table}.csv`);
  try {
    writeFileSync(csvPath, csv(columns, rows), { mode: 0o600 });
    const pair = target === undefined ? '' : `, from='Declaration', to='${target}'`;
    store.execute(`COPY ${table} FROM ${literal(csvPath)} (HEADER=true${pair})`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function csv(columns: readonly string[], rows: readonly object[]): string {
  return `${columns.join(',')}\n${rows.map((row) => columns.map((column) => csvValue((row as Record<string, unknown>)[column])).join(',')).join('\n')}\n`;
}

function csvValue(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return `"${String(value).replaceAll('"', '""')}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

function relationshipColumns(type: RelationshipType): readonly string[] {
  switch (type) {
    case 'CONTAINS': case 'IMPLEMENTS': case 'EXTENDS': return ['from', 'to'];
    case 'REFERENCES': return ['from', 'to', 'line', 'col', 'role'];
    case 'CALLS': return ['from', 'to', 'line', 'col', 'dispatch'];
    case 'TYPE_MENTION': return ['from', 'to', 'line', 'col', 'position'];
    case 'IMPORTS': return ['from', 'to', 'line', 'names'];
    case 'EXPORTS': return ['from', 'to', 'name', 'line', 'col'];
    case 'CHANGED': return ['from', 'to', 'added', 'removed'];
    case 'RENAMED_FROM': return ['from', 'to', 'basis', 'commit'];
  }
}

function relationshipTargets(type: RelationshipType): readonly RelationshipTarget[] {
  switch (type) {
    case 'REFERENCES': case 'CALLS': case 'TYPE_MENTION': case 'IMPORTS': return ['Declaration', 'External'];
    default: return ['Declaration'];
  }
}

const relationshipTypes: readonly RelationshipType[] = ['CONTAINS', 'REFERENCES', 'CALLS', 'IMPLEMENTS', 'EXTENDS', 'TYPE_MENTION', 'IMPORTS', 'EXPORTS', 'CHANGED', 'RENAMED_FROM'];

function validateGraph(graph: StoreGraph): void {
  for (const relationship of graph.relationships) {
    if (!relationshipTargets(relationship.type).includes(relationship.target)) throw new Error(`${relationship.type} cannot target ${relationship.target}.`);
    if (relationship.type === 'CHANGED' && relationship.target !== 'Declaration') throw new Error('CHANGED must target a Declaration.');
  }
}

function receiptFor(graph: StoreGraph): LoadReceipt {
  const relationships = Object.fromEntries(relationshipTypes.map((type) => [type, 0])) as Record<RelationshipType, number>;
  for (const relationship of graph.relationships) relationships[relationship.type] += 1;
  return { declarations: graph.declarations.length, externals: graph.externals.length, commits: graph.commits?.length ?? 0, relationships };
}
