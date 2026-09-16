import { DeclarationError } from '../../core/declarations.js';
import { matchesPathFilters } from '../../core/receipt.js';
import { query } from '../../store/query.js';
import type { StoreRow } from '../../store/store.js';
import type { SemanticHandler } from '../handlers.js';

interface FindRow { address: string; path: string; kind: string; exported: boolean; name: string; qualifiedName: string; }

const handler: SemanticHandler = async (context, invocation) => {
  await context.projects.bootstrap();
  const started = performance.now();
  const name = invocation.input.args[0]!;
  const flags = invocation.input.flags;
  const prefix = flags['--prefix'] === true;
  const qualified = name.includes('.');
  const rows = new Map<string, FindRow>();
  for (const declaration of declarations(context)) {
    const candidate = qualified ? declaration.qualifiedName : declaration.name;
    if (declaration.kind === 'module' || !(prefix ? candidate.startsWith(name) : candidate === name) || !keep(declaration, flags)) continue;
    rows.set(declaration.address, declaration);
  }
  for (const alias of aliases(context)) {
    const candidate = alias.qualifiedName;
    if (!(prefix ? candidate.startsWith(name) : candidate === name) || !keep(alias, flags)) continue;
    rows.set(alias.address, alias);
  }
  const sorted = [...rows.values()].sort((a, b) => a.path.localeCompare(b.path) || numericAddress(a.address, b.address));
  const limit = flags['--limit'] as number | undefined;
  const shown = limit === undefined ? sorted : sorted.slice(0, limit);
  const capped = shown.length < sorted.length;
  return {
    data: { element: 'find', attributes: { name, count: sorted.length, shown: capped ? shown.length : undefined }, text: shown.map((row) => `${row.address}  ${row.kind}${row.exported ? '  export' : ''}  ${row.qualifiedName}`).join('\n') },
    count: sorted.length,
    receipt: capped ? `${shown.length} of ${sorted.length} find rows shown, limit ${limit}, ${Math.round(performance.now() - started)} ms` : `${shown.length} find row${shown.length === 1 ? '' : 's'}, ${Math.round(performance.now() - started)} ms`,
  };
};

function declarations(context: Parameters<SemanticHandler>[0]): FindRow[] {
  if (!context.store) throw new DeclarationError('not-in-program', 'The TypeScript index is not available yet.');
  return query(context.store, 'MATCH (d:Declaration) RETURN d.at AS at, d.file AS file, d.kind AS kind, d.exported AS exported, d.name AS name, d.qname AS qname').map((row) => ({ address: String(row.at), path: String(row.file), kind: String(row.kind), exported: Boolean(row.exported), name: String(row.name), qualifiedName: String(row.qname) }));
}

function aliases(context: Parameters<SemanticHandler>[0]): FindRow[] {
  if (!context.store) throw new DeclarationError('not-in-program', 'The TypeScript index is not available yet.');
  return query(context.store, 'MATCH (m:Declaration)-[e:EXPORTS]->(d:Declaration) RETURN m.file AS fromFile, e.name AS name, e.line AS line, e.col AS col, d.file AS file, d.line AS declarationLine, d.col AS declarationCol').flatMap((row: StoreRow) => {
    const fromFile = String(row.fromFile);
    const line = Number(row.line);
    const col = Number(row.col);
    if (fromFile === String(row.file) && line === Number(row.declarationLine) && col === Number(row.declarationCol)) return [];
    return [{ address: `${fromFile}:${line}:${col}`, path: fromFile, kind: 'alias', exported: true, name: String(row.name), qualifiedName: String(row.name) }];
  });
}

function keep(row: FindRow, flags: Record<string, boolean | number | string | string[]>): boolean {
  const kinds = flags['--kind'] as string[] | undefined;
  return (!kinds || kinds.includes(row.kind)) && matchesPathFilters(row.path, { in: flags['--in'] as string[] | undefined, exclude: flags['--exclude'] as string[] | undefined });
}

function numericAddress(a: string, b: string): number { const [aLine, aColumn] = a.split(':').slice(-2).map(Number); const [bLine, bColumn] = b.split(':').slice(-2).map(Number); return aLine! - bLine! || aColumn! - bColumn!; }

export default handler;
