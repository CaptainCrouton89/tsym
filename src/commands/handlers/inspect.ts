import type { DeclarationRecord } from '../../core/declarations.js';
import { matchesPathFilters } from '../../core/receipt.js';
import { normalKind } from '../../read/read.js';
import { mergeGraphs } from '../../relations/graph.js';
import { implementations, memberSummaries, references, traverse, type MemberSummary, type ReferenceRow } from '../../relations/store-relations.js';
import { renderGraph } from '../../relations/mermaid.js';
import type { RelationRow, TraversalResult } from '../../relations/types.js';
import type { SemanticHandler } from '../handlers.js';
import type { Answer, OutputNode } from '../types.js';

const relationOrder = ['refs', 'callers', 'calls', 'impl', 'members'] as const;
type Relation = typeof relationOrder[number];
const containerKinds = new Set(['class', 'interface', 'enum', 'namespace', 'module', 'type']);
const callableMemberKinds = new Set(['function', 'method', 'constructor']);
// A zero is only worth the scope caveat when the kind could have had that relation: a function never has
// implementations and an interface never makes calls, so those zeros are structural, not a visibility gap.
const applicableKinds: Record<Exclude<Relation, 'members'>, ReadonlySet<string> | undefined> = {
  refs: undefined,
  callers: new Set(['function', 'method', 'constructor', 'getter', 'setter', 'class', 'const', 'let', 'var', 'property', 'module', 'namespace']),
  calls: new Set(['function', 'method', 'constructor', 'getter', 'setter', 'class', 'const', 'let', 'var', 'property', 'module', 'namespace']),
  impl: new Set(['class', 'interface']),
};
function applies(relation: Exclude<Relation, 'members'>, kind: string): boolean { return applicableKinds[relation]?.has(kind) ?? true; }
const zeroScopeReceipt = '0 counts cover indexed, compiler-resolved relations only; framework, HTTP, and dependency-injection invocation are not visible';

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
  let hasZeroRelation = false;
  const receiptParts: string[] = [];
  for (const seed of seeds) {
    const header = await signature(context, seed);
    const summaries = containerKinds.has(seed.kind) ? await memberSummaries(context, seed) : [];
    const isContainer = summaries.length > 0;
    const relations: OutputNode[] = [];
    const seedReceipt: string[] = [];
    for (const relation of selected) {
      if (relation === 'refs') {
        const rows = await references(context, seed, filters);
        answers += rows.length;
        hasZeroRelation ||= rows.length === 0;
        relations.push(refBlock(rows, each, true));
        seedReceipt.push(`${rows.length} refs`);
      } else if (relation === 'impl') {
        const rows = (await implementations(context, seed)).filter((item) => matchesPathFilters(item.location.path, filters));
        answers += rows.length;
        hasZeroRelation ||= rows.length === 0 && applies('impl', seed.kind);
        relations.push(implBlock(rows, each, applies('impl', seed.kind)));
        seedReceipt.push(`${rows.length} impl`);
      } else if (relation === 'members') {
        if (isContainer) {
          answers += summaries.length;
          relations.push(membersBlock(summaries, each));
          seedReceipt.push(`${summaries.length} members`);
        }
      } else {
        const result = await traverse(context, [seed], relation, depth, filters);
        answers += result.rows.length;
        hasZeroRelation ||= result.rows.length === 0 && applies(relation, seed.kind);
        relations.push(traversalBlock(relation, result, each, applies(relation, seed.kind)));
        seedReceipt.push(`${result.rows.length} ${relation}${result.excluded ? `, ${result.excluded} excluded` : ''}${result.unresolved ? `, ${result.unresolved} unresolved` : ''}${result.dispatch ? `, ${result.dispatch} dispatch` : ''}`);
      }
    }
    if (isContainer) seedReceipt.push(memberGuidance(seed, summaries));
    receiptParts.push(`${seed.name}: ${seedReceipt.join(', ') || 'no indexed members'}`);
    blocks.push({ element: 'inspect', attributes: { symbol: seed.address, name: seed.name, kind: normalKind(seed.kind), depth }, text: header, children: relations });
  }
  const capped = selected.length > 0 && each > 0;
  const only = selected.length === relationOrder.length ? '' : ` ${selected.map((relation) => `--only ${relation}`).join(' ')}`;
  const rerun = capped ? `; re-run tsym inspect ${invocation.input.args.join(' ')}${only} --each 0 for all rows` : '';
  const scope = hasZeroRelation ? `; ${zeroScopeReceipt}` : '';
  return { data: blocks, count: answers, receipt: `${receiptParts.join('; ')}, ${Math.round(performance.now() - started)} ms${rerun}${scope}` };
};

async function graphAnswer(context: Parameters<SemanticHandler>[0], seeds: DeclarationRecord[], selected: readonly Relation[], depth: number, filters: { in: string[]; exclude: string[] }, started: number): Promise<Answer> {
  const relations: TraversalResult[] = [];
  for (const relation of selected) if (relation === 'callers' || relation === 'calls') relations.push(await traverse(context, seeds, relation, depth, filters));
  const graph = mergeGraphs(relations.map((result) => result.graph));
  const count = relations.reduce((sum, result) => sum + result.rows.length, 0);
  const unresolved = new Set(graph.unresolved.map((site) => site.siteId)).size;
  const dispatch = new Set([...graph.unresolved.filter((site) => site.dispatch).map((site) => site.siteId), ...graph.edges.filter((edge) => edge.kind === 'impl').flatMap((edge) => edge.siteIds)]).size;
  const excluded = relations.reduce((sum, result) => sum + result.excluded, 0);
  const scope = relations.some((result) => result.rows.length === 0) ? `; ${zeroScopeReceipt}` : '';
  return { data: { element: 'inspect', attributes: { graph: true, count }, text: renderGraph(graph).replace(/\n$/, '') }, count, receipt: `${count} traversal rows${excluded ? `, ${excluded} excluded` : ''}${unresolved ? `, ${unresolved} unresolved` : ''}${dispatch ? `, ${dispatch} dispatch` : ''}, ${Math.round(performance.now() - started)} ms${scope}` };
}

async function signature(_context: Parameters<SemanticHandler>[0], record: DeclarationRecord): Promise<string> { return `${normalKind(record.kind)} ${record.qualifiedName}`; }

function relationBlock<T>(element: string, rows: readonly T[], path: (row: T) => string, each: number, format: (row: T) => string, scoped = false): OutputNode {
  if (!rows.length) return { element, attributes: { count: 0, scope: scoped ? 'compiler-resolved' : undefined } };
  const shown = shownRows(rows, each);
  return { element, attributes: { count: rows.length, files: new Set(rows.map(path)).size, shown: shown.length < rows.length ? shown.length : undefined }, text: shown.map(format).join('\n') };
}

function refBlock(rows: ReferenceRow[], each: number, scoped: boolean): OutputNode {
  return relationBlock('refs', rows, (row) => row.path, each, (row) => `${row.path}:${row.line}:${row.col}  ${row.kind}  ${row.qualifiedName}  ${row.role}`, scoped);
}

function implBlock(rows: DeclarationRecord[], each: number, scoped: boolean): OutputNode {
  return relationBlock('impl', rows, (row) => row.location.path, each, (row) => `${row.address}  ${normalKind(row.kind)}  ${row.qualifiedName}`, scoped);
}

function traversalBlock(relation: 'callers' | 'calls', result: TraversalResult, each: number, scoped: boolean): OutputNode {
  return relationBlock(relation, result.rows, (row) => row.path, each, formatTraversal, scoped);
}

function membersBlock(rows: MemberSummary[], each: number): OutputNode {
  return relationBlock('members', rows, (row) => row.path, each, formatMember);
}

function formatTraversal(row: RelationRow): string { return `${row.id}  ${row.depth}  ${normalKind(row.kind)}  ${row.qualifiedName}  (${row.callSites} ${row.callSites === 1 ? 'site' : 'sites'}${row.edgeKinds.includes('impl') ? ', impl' : ''})`; }
function formatMember(row: MemberSummary): string {
  const incoming = callableMemberKinds.has(row.kind) ? `${row.callers} callers` : `${row.refs} refs`;
  return `${row.address}  ${row.kind}  ${row.qualifiedName}  (${incoming}, ${row.calls} calls)`;
}
function memberGuidance(seed: DeclarationRecord, members: readonly MemberSummary[]): string {
  const target = [...members].sort((left, right) => right.callers - left.callers || left.line - right.line || left.col - right.col)[0]!;
  const callerScope = seed.kind === 'class' ? 'callers are constructor/type uses' : 'container callers do not include member calls';
  return `${callerScope}; methods have their own — inspect ${target.qualifiedName}`;
}
function shownRows<T>(rows: readonly T[], each: number): readonly T[] { return each === 0 ? rows : rows.slice(0, each); }
function selectedRelations(value: boolean | number | string | string[] | undefined): readonly Relation[] { const values = Array.isArray(value) ? value : relationOrder; return relationOrder.filter((relation) => values.includes(relation)); }
function strings(value: boolean | number | string | string[] | undefined): string[] { return Array.isArray(value) ? value : value === undefined ? [] : [String(value)]; }
export default handler;
