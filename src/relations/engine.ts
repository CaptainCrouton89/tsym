import type { DeclarationRecord } from '../core/declarations.js';
import type { SemanticContext } from '../server/context.js';
import { graphAfterExclusion, GraphBuilder, projectGraph } from './graph.js';
import { callSitesFor, classifyTarget, external, relative, targetAddress, type DefinitionTarget, type ProtocolSpan, type Site } from './syntax.js';
import { nodeFor, type Direction, type Graph, type TraversalResult } from './types.js';

interface HierarchyItem { file: string; selectionSpan?: { start: ProtocolSpan['start'] }; span?: { start: ProtocolSpan['start'] }; }
interface HierarchyCall { to?: HierarchyItem; from?: HierarchyItem; fromSpans?: ProtocolSpan[]; }

export async function traverse(context: SemanticContext, seeds: readonly DeclarationRecord[], direction: Direction, depth: number, filters: { in: readonly string[]; exclude: readonly string[] }): Promise<TraversalResult> {
  const builder = new GraphBuilder();
  const records = new Map<string, DeclarationRecord>();
  for (const seed of seeds) { builder.addNode(nodeFor(seed, 0)); records.set(seed.address, seed); }
  const roots = direction === 'callers' ? await incomingRoots(context, seeds) : seeds;
  for (const root of roots) { builder.addNode(nodeFor(root, 0)); records.set(root.address, root); }
  const seen = new Set(roots.map((record) => record.address));
  let frontier = [...roots];
  for (let level = 1; level <= depth && frontier.length; level++) {
    const next: DeclarationRecord[] = [];
    for (const current of frontier) {
      const found = direction === 'calls' ? await outgoing(context, current) : await incoming(context, current);
      for (const unresolved of found.unresolved) builder.addUnresolved(unresolved);
      for (const relation of found.edges) {
        builder.addNode(nodeFor(relation.record, level));
        records.set(relation.record.address, relation.record);
        builder.addEdge(relation.from, relation.to, relation.kind, relation.site.id);
        if (!seen.has(relation.record.address)) { seen.add(relation.record.address); next.push(relation.record); }
      }
    }
    frontier = next;
  }
  const pruned = graphAfterExclusion(builder.build(), filters.exclude, direction);
  return projectGraph(pruned, direction, filters.in);
}

export async function implementations(context: SemanticContext, record: DeclarationRecord): Promise<DeclarationRecord[]> {
  const body = await bodyOf(context, 'implementation', position(record));
  const definitions = definitionList(body);
  const rows: DeclarationRecord[] = [];
  for (const definition of definitions) {
    if (external(definition.file)) continue;
    const result = await recordFor(context, definition);
    if (result) rows.push(result);
  }
  return unique(rows);
}

interface FoundEdge { from: string; to: string; kind: 'call' | 'impl'; site: Site; record: DeclarationRecord; }
interface Found { edges: FoundEdge[]; unresolved: import('./types.js').UnresolvedSite[]; }

async function outgoing(context: SemanticContext, current: DeclarationRecord): Promise<Found> {
  const hierarchy = await bodyOf(context, 'provideCallHierarchyOutgoingCalls', position(current));
  const sites = callSitesFor(context, current);
  const bySite = new Map<string, DefinitionTarget[]>();
  for (const call of hierarchyCalls(hierarchy)) for (const rawSpan of call.fromSpans ?? []) {
    const span = spanIn(current.file, rawSpan);
    const site = sites.find((candidate) => candidate.file === span.file && candidate.line === span.start.line && candidate.callStart <= span.start.offset && candidate.col >= span.start.offset);
    if (site && call.to) bySite.set(site.id, [...(bySite.get(site.id) ?? []), hierarchySpan(call.to)]);
  }
  const edges: FoundEdge[] = [];
  const unresolved: import('./types.js').UnresolvedSite[] = [];
  for (const site of sites) {
    const targets = bySite.get(site.id) ?? await definitionsAt(context, site);
    const result = await followSite(context, current, site, targets);
    edges.push(...result.edges);
    if (result.unresolved) unresolved.push(result.unresolved);
  }
  return { edges, unresolved };
}

async function incoming(context: SemanticContext, current: DeclarationRecord): Promise<Found> {
  const entries = await incomingForTarget(context, current, current);
  const contracts = await contractTargets(context, current);
  for (const contract of contracts) entries.push(...await incomingForTarget(context, contract, current));
  const deduped = new Map<string, FoundEdge>();
  for (const entry of entries) deduped.set(`${entry.from}\0${entry.to}\0${entry.kind}\0${entry.site.id}`, entry);
  return { edges: [...deduped.values()], unresolved: [] };
}

async function incomingForTarget(context: SemanticContext, target: DeclarationRecord, concrete: DeclarationRecord): Promise<FoundEdge[]> {
  const body = await bodyOf(context, 'provideCallHierarchyIncomingCalls', position(target));
  const edges: FoundEdge[] = [];
  for (const call of hierarchyCalls(body)) {
    if (!call.from) continue;
    const source = await recordFor(context, hierarchySpan(call.from));
    if (!source) continue;
    for (const rawSpan of call.fromSpans ?? []) {
      const site = siteFromSpan(context, spanIn(source.file, rawSpan));
      const declared = await definitionsAt(context, site);
      const dispatch = declared.some((definition) => classifyTarget(context, definition) === 'dispatch');
      if (dispatch && !await implementsConcrete(context, declared, concrete)) continue;
      edges.push({ from: source.address, to: concrete.address, kind: dispatch ? 'impl' : 'call', site, record: source });
    }
  }
  return edges;
}

async function incomingRoots(context: SemanticContext, seeds: readonly DeclarationRecord[]): Promise<DeclarationRecord[]> {
  const roots = [...seeds];
  for (const seed of seeds) {
    const targets = await rawDefinitions(context, position(seed));
    if (!targets.some((target) => classifyTarget(context, target) === 'dispatch')) continue;
    for (const implementation of await implementations(context, seed)) roots.push(implementation);
  }
  return unique(roots);
}

async function contractTargets(context: SemanticContext, concrete: DeclarationRecord): Promise<DeclarationRecord[]> {
  const body = await bodyOf(context, 'references', position(concrete));
  const refs = referenceList(body);
  const targets: DeclarationRecord[] = [];
  for (const ref of refs) {
    const raw = await rawDefinitions(context, { file: ref.file, line: ref.start.line, offset: ref.start.offset });
    if (!raw.some((item) => classifyTarget(context, item) === 'dispatch')) continue;
    if (!await implementsConcrete(context, raw, concrete)) continue;
    for (const item of raw) if (classifyTarget(context, item) === 'dispatch') {
      const record = await recordFor(context, item);
      if (record) targets.push(record);
    }
  }
  return unique(targets.filter((target) => target.address !== concrete.address));
}

async function followSite(context: SemanticContext, current: DeclarationRecord, site: Site, targets: DefinitionTarget[]): Promise<{ edges: FoundEdge[]; unresolved?: import('./types.js').UnresolvedSite }> {
  if (!targets.length) return { edges: [], unresolved: unresolved(current, site, 'dynamic', false) };
  const classes = targets.map((target) => classifyTarget(context, target));
  const dispatch = classes.includes('dispatch');
  if (dispatch) {
    const implementations: DeclarationRecord[] = [];
    for (const target of targets.filter((_, index) => classes[index] === 'dispatch')) implementations.push(...await implementationsAt(context, target));
    const concrete = unique(implementations);
    if (concrete.length) return { edges: concrete.map((record) => ({ from: current.address, to: record.address, kind: 'impl', site, record })) };
    return { edges: [], unresolved: unresolved(current, site, targets.some((target) => external(target.file)) ? 'external' : 'dispatch', true) };
  }
  const concrete: DeclarationRecord[] = [];
  for (let index = 0; index < targets.length; index++) if (classes[index] === 'concrete' && !external(targets[index]!.file)) {
    const record = await recordFor(context, targets[index]!);
    if (record) concrete.push(record);
  }
  if (concrete.length) return { edges: unique(concrete).map((record) => ({ from: current.address, to: record.address, kind: 'call', site, record })) };
  return { edges: [], unresolved: unresolved(current, site, targets.some((target) => external(target.file)) ? 'external' : 'dynamic', false) };
}

async function implementationsAt(context: SemanticContext, target: DefinitionTarget): Promise<DeclarationRecord[]> {
  const body = await bodyOf(context, 'implementation', { file: target.file, line: target.start.line, offset: target.start.offset });
  const records: DeclarationRecord[] = [];
  for (const definition of definitionList(body)) if (!external(definition.file)) {
    const record = await recordFor(context, definition);
    if (record) records.push(record);
  }
  return unique(records);
}

async function implementsConcrete(context: SemanticContext, targets: DefinitionTarget[], concrete: DeclarationRecord): Promise<boolean> {
  for (const target of targets) for (const implementation of await implementationsAt(context, target)) if (implementation.address === concrete.address) return true;
  return false;
}

async function definitionsAt(context: SemanticContext, site: Site): Promise<DefinitionTarget[]> { return rawDefinitions(context, { file: site.file, line: site.line, offset: site.col }); }
async function rawDefinitions(context: SemanticContext, point: { file: string; line: number; offset: number }): Promise<DefinitionTarget[]> { return definitionList(await bodyOf(context, 'definitionAndBoundSpan', point)); }
async function recordFor(context: SemanticContext, target: DefinitionTarget): Promise<DeclarationRecord | null> {
  try { return await context.resolver.resolve(targetAddress(context, target)); } catch { return null; }
}
function hierarchySpan(item: HierarchyItem): DefinitionTarget { return { file: item.file, start: (item.selectionSpan ?? item.span)!.start }; }
function position(record: DeclarationRecord): { file: string; line: number; offset: number } { return { file: record.file, line: record.location.line, offset: record.location.col }; }
function spanIn(file: string, span: ProtocolSpan): ProtocolSpan { return { ...span, file: span.file ?? file }; }
function siteFromSpan(context: SemanticContext, span: ProtocolSpan): Site { const path = relative(context.root, span.file); return { id: `${path}:${span.start.line}:${span.start.offset}`, file: span.file, path, line: span.start.line, col: span.start.offset, callStart: span.start.offset, text: context.source.read(span.file).split('\n')[span.start.line - 1] ?? '' }; }
function unresolved(current: DeclarationRecord, site: Site, reason: import('./types.js').UnresolvedReason, dispatch: boolean): import('./types.js').UnresolvedSite { return { from: current.address, siteId: site.id, name: site.text, reason, path: site.path, start: { line: site.line, col: site.col }, text: site.text, dispatch }; }
async function bodyOf(context: SemanticContext, command: string, args: Record<string, unknown>): Promise<unknown> { const response = await context.session.request(command, args); if (response.success === false) throw new Error(`TypeScript rejected ${command}.`); return response.body; }
function definitionList(body: unknown): DefinitionTarget[] { const value = body as { definitions?: unknown } | unknown[]; const definitions = Array.isArray(value) ? value : value?.definitions; return Array.isArray(definitions) ? definitions.filter(validSpan) : []; }
function referenceList(body: unknown): ProtocolSpan[] { const value = body as { refs?: unknown } | unknown[]; const refs = Array.isArray(value) ? value : value?.refs; return Array.isArray(refs) ? refs.filter(validSpan) : []; }
function hierarchyCalls(body: unknown): HierarchyCall[] { return Array.isArray(body) ? body as HierarchyCall[] : []; }
function validSpan(value: unknown): value is DefinitionTarget { const item = value as DefinitionTarget; return typeof item?.file === 'string' && typeof item.start?.line === 'number' && typeof item.start?.offset === 'number'; }
function unique(records: readonly DeclarationRecord[]): DeclarationRecord[] { return [...new Map(records.map((record) => [record.address, record])).values()]; }
