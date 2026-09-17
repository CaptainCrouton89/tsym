import type { DeclarationRecord } from '../../core/declarations.js';
import { matchesPathFilters } from '../../core/receipt.js';
import { normalKind } from '../../read/read.js';
import { mergeGraphs } from '../../relations/graph.js';
import { implementations, references, traverse, type ReferenceRow } from '../../relations/store-relations.js';
import { renderGraph } from '../../relations/mermaid.js';
import type { RelationRow, TraversalResult } from '../../relations/types.js';
import type { SemanticHandler } from '../handlers.js';
import type { Answer, OutputNode } from '../types.js';

const relationOrder = ['refs', 'callers', 'calls', 'impl'] as const;
type Relation = typeof relationOrder[number];
const handler: SemanticHandler = async (context, invocation) => {
  const started = performance.now();
  const selected = selectedRelations(invocation.input.flags['--only']);
  const each = invocation.input.flags['--each'] as number;
  const depth = invocation.input.flags['--depth'] as number;
  const graphMode = invocation.input.flags['--graph'] === true;
  const filters = { in: strings(invocation.input.flags['--in']), exclude: strings(invocation.input.flags['--exclude']) };
  const seeds = await context.resolver.resolveAll(invocation.input.args);
    if (graphMode) return graphAnswer(context, seeds, selected, depth, filters, started);
    const blocks: OutputNode[] = [];
    let answers = 0;
    const receiptParts: string[] = [];
    for (const seed of seeds) {
      const header = await signature(context, seed);
      const relations: OutputNode[] = [];
      for (const relation of selected) {
        if (relation === 'refs') {
          const rows = await references(context, seed, filters);
          answers += rows.length;
          relations.push(refBlock(rows, each));
          receiptParts.push(`${rows.length} refs`);
        } else if (relation === 'impl') {
          const rows = (await implementations(context, seed)).filter((item) => matchesPathFilters(item.location.path, filters));
          answers += rows.length;
          relations.push(implBlock(rows, each));
          receiptParts.push(`${rows.length} impl`);
        } else {
          const result = await traverse(context, [seed], relation, depth, filters);
          answers += result.rows.length;
          relations.push(traversalBlock(relation, result, each));
          receiptParts.push(`${result.rows.length} ${relation}${result.excluded ? `, ${result.excluded} excluded` : ''}${result.unresolved ? `, ${result.unresolved} unresolved` : ''}${result.dispatch ? `, ${result.dispatch} dispatch` : ''}`);
        }
      }
      blocks.push({ element: 'inspect', attributes: { symbol: seed.address, name: seed.name, kind: normalKind(seed.kind), depth }, text: header, children: relations });
    }
    const capped = selected.some((relation) => relation === 'refs' || relation === 'impl' || relation === 'calls' || relation === 'callers') && each > 0;
    const rerun = capped ? `; re-run tsym inspect ${invocation.input.args.join(' ')} --only ${selected[0]} --each 0 for all rows` : '';
  return { data: blocks, count: answers, receipt: `${invocation.input.args.map((input, index) => `${seeds[index]!.name}: ${receiptParts.slice(index * selected.length, (index + 1) * selected.length).join(', ')}`).join('; ')}, ${Math.round(performance.now() - started)} ms${rerun}` };
};

async function graphAnswer(context: Parameters<SemanticHandler>[0], seeds: DeclarationRecord[], selected: readonly Relation[], depth: number, filters: { in: string[]; exclude: string[] }, started: number): Promise<Answer> {
  const relations: TraversalResult[] = [];
  for (const relation of selected) if (relation === 'callers' || relation === 'calls') relations.push(await traverse(context, seeds, relation, depth, filters));
  const graph = mergeGraphs(relations.map((result) => result.graph));
  const count = relations.reduce((sum, result) => sum + result.rows.length, 0);
  const unresolved = new Set(graph.unresolved.map((site) => site.siteId)).size;
  const dispatch = new Set([...graph.unresolved.filter((site) => site.dispatch).map((site) => site.siteId), ...graph.edges.filter((edge) => edge.kind === 'impl').flatMap((edge) => edge.siteIds)]).size;
  const excluded = relations.reduce((sum, result) => sum + result.excluded, 0);
  return { data: { element: 'inspect', attributes: { graph: true, count }, text: renderGraph(graph).replace(/\n$/, '') }, count, receipt: `${count} traversal rows${excluded ? `, ${excluded} excluded` : ''}${unresolved ? `, ${unresolved} unresolved` : ''}${dispatch ? `, ${dispatch} dispatch` : ''}, ${Math.round(performance.now() - started)} ms` };
}

async function signature(_context: Parameters<SemanticHandler>[0], record: DeclarationRecord): Promise<string> { return `${normalKind(record.kind)} ${record.qualifiedName}`; }

function relationBlock<T>(element: string, rows: readonly T[], path: (row: T) => string, each: number, format: (row: T) => string): OutputNode {
  if (!rows.length) return { element, attributes: { count: 0 } };
  const shown = shownRows(rows, each);
  return { element, attributes: { count: rows.length, files: new Set(rows.map(path)).size, shown: shown.length < rows.length ? shown.length : undefined }, text: shown.map(format).join('\n') };
}
function refBlock(rows: ReferenceRow[], each: number): OutputNode {
  return relationBlock('refs', rows, (row) => row.path, each, (row) => `${row.path}:${row.line}:${row.col}  ${row.kind}  ${row.qualifiedName}  ${row.role}`);
}
function implBlock(rows: DeclarationRecord[], each: number): OutputNode {
  return relationBlock('impl', rows, (row) => row.location.path, each, (row) => `${row.address}  ${normalKind(row.kind)}  ${row.qualifiedName}`);
}
function traversalBlock(relation: 'callers' | 'calls', result: TraversalResult, each: number): OutputNode {
  return relationBlock(relation, result.rows, (row) => row.path, each, formatTraversal);
}
function formatTraversal(row: RelationRow): string { return `${row.id}  ${row.depth}  ${normalKind(row.kind)}  ${row.qualifiedName}  (${row.callSites} ${row.callSites === 1 ? 'site' : 'sites'}${row.edgeKinds.includes('impl') ? ', impl' : ''})`; }
function shownRows<T>(rows: readonly T[], each: number): readonly T[] { return each === 0 ? rows : rows.slice(0, each); }
function selectedRelations(value: boolean | number | string | string[] | undefined): readonly Relation[] { const values = Array.isArray(value) ? value : relationOrder; return relationOrder.filter((relation) => values.includes(relation)); }
function strings(value: boolean | number | string | string[] | undefined): string[] { return Array.isArray(value) ? value : value === undefined ? [] : [String(value)]; }
export default handler;
