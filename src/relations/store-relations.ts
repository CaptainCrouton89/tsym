import type { DeclarationRecord } from '../core/declarations.js';
import { matchesPathFilters } from '../core/receipt.js';
import { query } from '../store/query.js';
import type { StoreRow } from '../store/store.js';
import type { SemanticContext } from '../server/context.js';
import { graphAfterExclusion, GraphBuilder, projectGraph } from './graph.js';
import { nodeFor, type Direction, type TraversalResult, type UnresolvedSite } from './types.js';

export interface ReferenceRow {
  path: string;
  line: number;
  col: number;
  kind: string;
  qualifiedName: string;
  role: string;
}

export async function references(context: SemanticContext, record: DeclarationRecord, filters: { in: readonly string[]; exclude: readonly string[] }): Promise<ReferenceRow[]> {
  const rows = storeRows(context, 'MATCH (owner:Declaration)-[reference:REFERENCES]->(target:Declaration) WHERE target.key = $key RETURN owner.file AS file, owner.line AS declarationLine, owner.col AS declarationCol, reference.line AS line, reference.col AS col, reference.role AS role', { key: recordKey(context, record) });
  const records = new Map<string, DeclarationRecord>();
  for (const row of rows) {
    const address = declarationAddress(row);
    records.set(address, await context.resolver.resolve(address));
  }
  return rows.flatMap((row) => {
    const owner = records.get(declarationAddress(row));
    if (!owner || !matchesPathFilters(owner.location.path, filters)) return [];
    return [{ path: owner.location.path, line: number(row, 'line'), col: number(row, 'col'), kind: owner.kind, qualifiedName: owner.qualifiedName, role: text(row, 'role') }];
  }).sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.col - b.col);
}

export async function implementations(context: SemanticContext, record: DeclarationRecord): Promise<DeclarationRecord[]> {
  const key = recordKey(context, record);
  const rows = [
    ...storeRows(context, 'MATCH (impl:Declaration)-[:IMPLEMENTS]->(target:Declaration) WHERE target.key = $key RETURN DISTINCT impl.file AS file, impl.line AS declarationLine, impl.col AS declarationCol', { key }),
    ...storeRows(context, 'MATCH (impl:Declaration)-[:EXTENDS]->(target:Declaration) WHERE target.key = $key RETURN DISTINCT impl.file AS file, impl.line AS declarationLine, impl.col AS declarationCol', { key }),
  ];
  return resolveRows(context, rows);
}

export async function traverse(context: SemanticContext, seeds: readonly DeclarationRecord[], direction: Direction, depth: number, filters: { in: readonly string[]; exclude: readonly string[] }): Promise<TraversalResult> {
  const builder = new GraphBuilder();
  const keys = new Map<string, string>();
  for (const seed of seeds) {
    builder.addNode(nodeFor(seed, 0));
    keys.set(seed.address, recordKey(context, seed));
  }
  const roots = direction === 'callers' ? await incomingRoots(context, seeds, keys) : seeds;
  for (const root of roots) builder.addNode(nodeFor(root, 0));
  const seen = new Set(roots.map((root) => root.address));
  let frontier = [...roots];
  for (let level = 1; level <= depth && frontier.length; level++) {
    const next: DeclarationRecord[] = [];
    for (const current of frontier) {
      const found = direction === 'calls' ? await outgoing(context, current, keys) : await incoming(context, current, keys);
      for (const unresolved of found.unresolved) builder.addUnresolved(unresolved);
      for (const edge of found.edges) {
        builder.addNode(nodeFor(edge.record, level));
        builder.addEdge(edge.from, edge.to, edge.kind, edge.siteId);
        if (!seen.has(edge.record.address)) {
          seen.add(edge.record.address);
          next.push(edge.record);
        }
      }
    }
    frontier = next;
  }
  return projectGraph(graphAfterExclusion(builder.build(), filters.exclude, direction), direction, filters.in);
}

interface FoundEdge {
  from: string;
  to: string;
  kind: 'call' | 'impl';
  siteId: string;
  record: DeclarationRecord;
}

interface Found {
  edges: readonly FoundEdge[];
  unresolved: readonly UnresolvedSite[];
}

async function outgoing(context: SemanticContext, current: DeclarationRecord, keys: Map<string, string>): Promise<Found> {
  const key = keyFor(context, current, keys);
  const declarationRows = storeRows(context, 'MATCH (source:Declaration)-[call:CALLS]->(target:Declaration) WHERE source.key = $key RETURN target.file AS file, target.line AS declarationLine, target.col AS declarationCol, call.line AS line, call.col AS col, call.dispatch AS dispatch', { key });
  const externalRows = storeRows(context, 'MATCH (source:Declaration)-[call:CALLS]->(target:External) WHERE source.key = $key RETURN target.name AS name, call.line AS line, call.col AS col', { key });
  const edges: FoundEdge[] = [];
  const unresolved: UnresolvedSite[] = externalRows.map((row) => unresolvedSite(current, row, text(row, 'name'), 'external', false));
  for (const row of declarationRows) {
    const siteId = site(current, row);
    const target = await context.resolver.resolve(declarationAddress(row));
    const targetKey = keyFor(context, target, keys);
    if (!boolean(row, 'dispatch')) {
      edges.push({ from: current.address, to: target.address, kind: 'call', siteId, record: target });
      continue;
    }
    const implementations = await implementationRows(context, targetKey);
    if (!implementations.length) {
      unresolved.push(unresolvedSite(current, row, target.name, 'dispatch', true));
      continue;
    }
    for (const implementation of implementations) {
      keys.set(implementation.address, keyFor(context, implementation, keys));
      edges.push({ from: current.address, to: implementation.address, kind: 'impl', siteId, record: implementation });
    }
  }
  return { edges, unresolved };
}

async function incomingRoots(context: SemanticContext, seeds: readonly DeclarationRecord[], keys: Map<string, string>): Promise<DeclarationRecord[]> {
  const roots = new Map(seeds.map((seed) => [seed.address, seed]));
  for (const seed of seeds) for (const implementation of await implementationRows(context, keyFor(context, seed, keys))) roots.set(implementation.address, implementation);
  return [...roots.values()];
}

async function incoming(context: SemanticContext, current: DeclarationRecord, keys: Map<string, string>): Promise<Found> {
  const key = keyFor(context, current, keys);
  const edges: FoundEdge[] = [];
  for (const row of storeRows(context, 'MATCH (caller:Declaration)-[call:CALLS]->(target:Declaration) WHERE target.key = $key AND call.dispatch = false RETURN caller.file AS file, caller.line AS declarationLine, caller.col AS declarationCol, call.line AS line, call.col AS col', { key })) {
    const caller = await context.resolver.resolve(declarationAddress(row));
    keys.set(caller.address, keyFor(context, caller, keys));
    edges.push({ from: caller.address, to: current.address, kind: 'call', siteId: site(caller, row), record: caller });
  }
  for (const contractKey of storeRows(context, 'MATCH (concrete:Declaration)-[:IMPLEMENTS]->(target:Declaration) WHERE concrete.key = $key RETURN DISTINCT target.key AS key', { key }).map((row) => text(row, 'key'))) {
    for (const row of storeRows(context, 'MATCH (caller:Declaration)-[call:CALLS]->(target:Declaration) WHERE target.key = $key AND call.dispatch = true RETURN caller.file AS file, caller.line AS declarationLine, caller.col AS declarationCol, call.line AS line, call.col AS col', { key: contractKey })) {
      const caller = await context.resolver.resolve(declarationAddress(row));
      keys.set(caller.address, keyFor(context, caller, keys));
      edges.push({ from: caller.address, to: current.address, kind: 'impl', siteId: site(caller, row), record: caller });
    }
  }
  return { edges, unresolved: [] };
}

async function implementationRows(context: SemanticContext, targetKey: string): Promise<DeclarationRecord[]> {
  return resolveRows(context, storeRows(context, 'MATCH (impl:Declaration)-[:IMPLEMENTS]->(target:Declaration) WHERE target.key = $key RETURN DISTINCT impl.file AS file, impl.line AS declarationLine, impl.col AS declarationCol', { key: targetKey }));
}

async function resolveRows(context: SemanticContext, rows: readonly StoreRow[]): Promise<DeclarationRecord[]> {
  const records = new Map<string, DeclarationRecord>();
  for (const row of rows) {
    const address = declarationAddress(row);
    records.set(address, await context.resolver.resolve(address));
  }
  return [...records.values()];
}

function storeRows(context: SemanticContext, statement: string, parameters: Record<string, string | number>): StoreRow[] {
  if (!context.store) throw new Error('The TypeScript index is not available yet.');
  return query(context.store, statement, parameters);
}

function recordKey(context: SemanticContext, record: DeclarationRecord): string {
  const { path: file, line, col } = record.location;
  const rows = storeRows(context, 'MATCH (declaration:Declaration) WHERE declaration.file = $file AND declaration.line = $line AND declaration.col = $col RETURN declaration.key AS key', { file, line, col });
  const key = rows[0] && text(rows[0], 'key');
  if (!key) throw new Error(`${record.address} is absent from the TypeScript index.`);
  return key;
}

function keyFor(context: SemanticContext, record: DeclarationRecord, keys: Map<string, string>): string {
  const key = keys.get(record.address) ?? recordKey(context, record);
  keys.set(record.address, key);
  return key;
}

function declarationAddress(row: StoreRow): string { return `${text(row, 'file')}:${number(row, 'declarationLine')}:${number(row, 'declarationCol')}`; }
function site(record: DeclarationRecord, row: StoreRow): string { return `${record.location.path}:${number(row, 'line')}:${number(row, 'col')}`; }
function unresolvedSite(record: DeclarationRecord, row: StoreRow, name: string, reason: UnresolvedSite['reason'], dispatch: boolean): UnresolvedSite {
  const line = number(row, 'line');
  const col = number(row, 'col');
  return { from: record.address, siteId: `${record.location.path}:${line}:${col}`, name, reason, path: record.location.path, start: { line, col }, text: name, dispatch };
}
function text(row: StoreRow, key: string): string { return String(row[key] ?? ''); }
function number(row: StoreRow, key: string): number { return Number(row[key]); }
function boolean(row: StoreRow, key: string): boolean { return row[key] === true; }
