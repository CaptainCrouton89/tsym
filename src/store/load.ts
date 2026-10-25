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
export type RelationshipTarget = 'Declaration' | 'External' | 'Commit';

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
  oldKey?: string;
  basis?: 'text-identical' | 'container-renamed' | 'file-moved';
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
    const loaded = withCheckpointHistory(graph, checkpointHistory(store));
    clearGraph(store);
    copyGraph(store, loaded);
    return receiptFor(loaded);
  });
}

/** Rehydrates the persisted graph when an unchanged workspace reuses its store across a resident restart. */
export function readGraph(store: Store): StoreGraph {
  const declarations = store.execute('MATCH (d:Declaration) RETURN d.key AS key, d.at AS at, d.name AS name, d.qname AS qname, d.kind AS kind, d.exported AS exported, d.file AS file, d.dir AS dir, d.top AS top, d.line AS line, d.col AS col, d.endLine AS endLine, d.lines AS lines, d.declCount AS declCount, d.container AS container').map((row) => ({
    key: String(row.key), at: String(row.at), name: String(row.name), qname: String(row.qname), kind: String(row.kind), exported: Boolean(row.exported), file: String(row.file), dir: String(row.dir), top: String(row.top), line: Number(row.line), col: Number(row.col), endLine: Number(row.endLine), lines: Number(row.lines), declCount: Number(row.declCount), container: row.container === null ? null : String(row.container),
  }));
  const externals = store.execute('MATCH (e:External) RETURN e.key AS key, e.module AS module, e.name AS name').map((row) => ({ key: String(row.key), module: String(row.module), name: String(row.name) }));
  const commits = store.execute('MATCH (c:Commit) RETURN c.hash AS hash, c.ts AS ts, c.author AS author, c.subject AS subject').map((row) => ({ hash: String(row.hash), ts: String(row.ts), author: String(row.author), subject: String(row.subject) }));
  const relationships = relationshipTypes.flatMap((type) => relationshipTargets(type).flatMap((target) => readRelationships(store, type, target)));
  return { declarations, externals, commits, relationships };
}

/** Atomically replaces every changed file, so relationships can target declarations created by the same refresh. */
export function replaceFiles(store: Store, files: readonly string[], graph: StoreGraph): LoadReceipt {
  const replaced = new Set(files);
  if (graph.declarations.some((declaration) => !replaced.has(declaration.file))) throw new Error('Replacement graph contains a declaration outside the replaced files.');
  validateGraph(graph);
  return store.transaction(() => {
    const history = checkpointHistory(store, replaced);
    if (replaced.size > 0) store.execute('MATCH (d:Declaration) WHERE d.file IN $files DETACH DELETE d', { files: [...replaced] });
    copyRows(store, 'Declaration', declarationColumns, graph.declarations);
    copyMissingExternals(store, graph.externals);
    copyMissingCommits(store, graph.commits ?? []);
    copyRelationships(store, graph.relationships);
    copyRelationships(store, history.changed.filter((relationship) => graph.declarations.some((declaration) => declaration.key === relationship.to)));
    copyRelationships(store, history.renamed.filter((relationship) => graph.declarations.some((declaration) => declaration.key === relationship.from)));
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

interface CheckpointHistory { commits: CommitRow[]; changed: RelationshipRow[]; renamed: RelationshipRow[]; }

/** Commit checkpoints survive graph replacement when their declaration target still exists. */
function withCheckpointHistory(graph: StoreGraph, history: CheckpointHistory): StoreGraph {
  const keys = new Set(graph.declarations.map((declaration) => declaration.key));
  const commits = new Map((graph.commits ?? []).map((commit) => [commit.hash, commit]));
  for (const commit of history.commits) commits.set(commit.hash, commit);
  return {
    ...graph,
    commits: [...commits.values()],
    relationships: [...graph.relationships, ...history.changed.filter((relationship) => keys.has(relationship.to)), ...history.renamed.filter((relationship) => keys.has(relationship.from))],
  };
}

function checkpointHistory(store: Store, files?: ReadonlySet<string>): CheckpointHistory {
  const commits = store.execute('MATCH (c:Commit) RETURN c.hash AS hash, c.ts AS ts, c.author AS author, c.subject AS subject').map((row) => ({ hash: String(row.hash), ts: String(row.ts), author: String(row.author), subject: String(row.subject) }));
  const where = files === undefined ? '' : ` WHERE ${[...files].map((file) => `d.file = ${literal(file)}`).join(' OR ')}`;
  const changed = store.execute(`MATCH (c:Commit)-[r:CHANGED]->(d:Declaration)${where} RETURN c.hash AS from, d.key AS to, r.added AS added, r.removed AS removed`).map((row) => ({ type: 'CHANGED' as const, from: String(row.from), to: String(row.to), target: 'Declaration' as const, added: Number(row.added), removed: Number(row.removed) }));
  const renamed = store.execute(`MATCH (d:Declaration)-[r:RENAMED_FROM]->(c:Commit)${where} RETURN d.key AS from, c.hash AS to, r.oldKey AS oldKey, r.basis AS basis`).map((row) => ({ type: 'RENAMED_FROM' as const, from: String(row.from), to: String(row.to), target: 'Commit' as const, oldKey: String(row.oldKey), basis: String(row.basis) as RelationshipRow['basis'] }));
  return { commits, changed, renamed };
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
    case 'RENAMED_FROM': return ['from', 'to', 'oldKey', 'basis'];
  }
}

function relationshipTargets(type: RelationshipType): readonly RelationshipTarget[] {
  switch (type) {
    case 'REFERENCES': case 'CALLS': case 'TYPE_MENTION': case 'IMPORTS': return ['Declaration', 'External'];
    case 'RENAMED_FROM': return ['Commit'];
    default: return ['Declaration'];
  }
}

const relationshipTypes: readonly RelationshipType[] = ['CONTAINS', 'REFERENCES', 'CALLS', 'IMPLEMENTS', 'EXTENDS', 'TYPE_MENTION', 'IMPORTS', 'EXPORTS', 'CHANGED', 'RENAMED_FROM'];

function readRelationships(store: Store, type: RelationshipType, target: RelationshipTarget): RelationshipRow[] {
  const source = type === 'CHANGED' ? 'Commit' : 'Declaration';
  const columns = relationshipColumns(type).filter((column) => column !== 'from' && column !== 'to').map((column) => `r.${column} AS ${column}`).join(', ');
  const returned = [`a.${type === 'CHANGED' ? 'hash' : 'key'} AS from`, `b.${target === 'Commit' ? 'hash' : 'key'} AS to`, columns].filter(Boolean).join(', ');
  // One unpaged read: SKIP/LIMIT without a total order over a parallel scan returns overlapping pages and drops rows.
  const rows = store.execute(`MATCH (a:${source})-[r:${type}]->(b:${target}) RETURN ${returned}`);
  return rows.map((row) => {
    const relationship: RelationshipRow = { type, from: String(row.from), to: String(row.to), target };
    for (const column of relationshipColumns(type)) {
      if (column === 'from' || column === 'to' || row[column] === undefined) continue;
      const value = row[column];
      if (column === 'line' || column === 'col' || column === 'added' || column === 'removed') Object.assign(relationship, { [column]: Number(value) });
      else if (column === 'dispatch') Object.assign(relationship, { dispatch: Boolean(value) });
      else Object.assign(relationship, { [column]: String(value) });
    }
    return relationship;
  });
}

function validateGraph(graph: StoreGraph): void {
  for (const relationship of graph.relationships) {
    if (!relationshipTargets(relationship.type).includes(relationship.target)) throw new Error(`${relationship.type} cannot target ${relationship.target}.`);
    if (relationship.type === 'CHANGED' && relationship.target !== 'Declaration') throw new Error('CHANGED must target a Declaration.');
    if (relationship.type === 'RENAMED_FROM' && relationship.target !== 'Commit') throw new Error('RENAMED_FROM must target a Commit.');
  }
}

function receiptFor(graph: StoreGraph): LoadReceipt {
  const relationships = Object.fromEntries(relationshipTypes.map((type) => [type, 0])) as Record<RelationshipType, number>;
  for (const relationship of graph.relationships) relationships[relationship.type] += 1;
  return { declarations: graph.declarations.length, externals: graph.externals.length, commits: graph.commits?.length ?? 0, relationships };
}
