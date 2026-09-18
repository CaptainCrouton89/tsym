import { statSync } from 'node:fs';
import path from 'node:path';
import { DeclarationError } from '../../core/declarations.js';
import { membersByContainer } from '../../core/members.js';
import { matchesPathFilters } from '../../core/receipt.js';
import { displayPath, scopeFiles } from '../../read/read.js';
import { query } from '../../store/query.js';
import type { StoreRow } from '../../store/store.js';
import type { SemanticHandler } from '../handlers.js';

interface Declaration { key: string; address: string; path: string; name: string; qualifiedName: string; kind: string; exported: boolean; line: number; col: number; lines: number; container: string | null; }
interface Import { address: string; path: string; line: number; name: string; target: string; }
interface Row { text: string; line: number; col: number; file?: string; }
const containers = new Set(['class', 'interface', 'enum', 'namespace']);

const handler: SemanticHandler = async (context, invocation) => {
  await context.projects.bootstrap();
  const started = performance.now();
  const flags = invocation.input.flags;
  const depth = flags['--depth'] as number;
  const scope = await scopeFiles(context, invocation.cwd, invocation.input.args);
  const selected = new Set(scope.files.map((file) => displayPath(context.root, file)).filter((file) => matchesPathFilters(file, { in: flags['--in'] as string[] | undefined, exclude: flags['--exclude'] as string[] | undefined })));
  const selectedFiles = [...selected];
  const declarations = indexed(context, selectedFiles).filter((declaration) => declaration.kind !== 'module');
  const imports = flags['--imports'] === true && flags['--exported'] !== true && !flags['--kind'] ? indexedImports(context, selectedFiles) : [];
  const directory = invocation.input.args.length === 0 ? context.root : invocation.input.args.map((input) => path.resolve(invocation.cwd, input)).find((candidate) => {
    try { return statSync(candidate).isDirectory(); } catch { return false; }
  });
  const requestedDirectory = directory !== undefined;
  const outlinedFile = directFile(invocation);
  const files = new Map<string, Declaration[]>();
  for (const declaration of declarations) files.set(declaration.path, [...(files.get(declaration.path) ?? []), declaration]);
  const importsByFile = new Map<string, Import[]>();
  for (const item of imports) {
    files.set(item.path, files.get(item.path) ?? []);
    importsByFile.set(item.path, [...(importsByFile.get(item.path) ?? []), item]);
  }
  const rows = requestedDirectory && depth === 1
    ? containerRows(context.root, files, importsByFile, flags, directory ?? context.root)
    : [...files.entries()].flatMap(([file, items]) => [...select(items, flags, requestedDirectory ? depth - 1 : depth).map((symbol) => symbolRow(context.root, symbol, items, flags)), ...(importsByFile.get(file) ?? []).map(importRow)].sort(byPosition));
  const limit = flags['--limit'] as number | undefined;
  const shown = limit === undefined ? rows : rows.slice(0, limit);
  const capped = shown.length < rows.length;
  const symbols = [...files.values()].flatMap((items) => select(items, flags, requestedDirectory ? depth - 1 : depth)).length + imports.length;
  const receipt = `${capped ? `${shown.length} of ${rows.length} outline rows shown, limit ${limit}` : `${shown.length} outline row${shown.length === 1 ? '' : 's'}`}${scope.notInProgram > 0 ? `, ${scope.notInProgram} not in program` : ''}, ${Math.round(performance.now() - started)} ms`;
  return { data: { element: 'outline', attributes: { path: invocation.input.args.join(' ') || '.', depth, symbols, files: files.size, count: rows.length, shown: capped ? shown.length : undefined }, text: shown.map((row) => row.text).join('\n') }, count: rows.length, displayedFiles: outlinedFile && shown.length > 0 ? [outlinedFile] : [...new Set(shown.flatMap((row) => row.file ? [row.file] : []))], receipt };
};

function directFile(invocation: Parameters<SemanticHandler>[1]): string | undefined {
  if (invocation.input.args.length !== 1) return undefined;
  const candidate = path.resolve(invocation.cwd, invocation.input.args[0]!);
  try { return statSync(candidate).isFile() ? candidate : undefined; } catch { return undefined; }
}

function indexed(context: Parameters<SemanticHandler>[0], files: readonly string[]): Declaration[] {
  if (!context.store) throw new DeclarationError('not-in-program', 'The TypeScript index is not available yet.');
  return files.length === 0 ? [] : query(context.store, 'MATCH (d:Declaration) WHERE d.file IN $files RETURN d.key AS key, d.at AS at, d.name AS name, d.qname AS qname, d.kind AS kind, d.exported AS exported, d.file AS file, d.line AS line, d.col AS col, d.lines AS lines, d.container AS container', { files: [...files] }).map(declaration);
}

function declaration(row: StoreRow): Declaration {
  return { key: String(row.key), address: String(row.at), path: String(row.file), name: String(row.name), qualifiedName: String(row.qname), kind: String(row.kind), exported: Boolean(row.exported), line: Number(row.line), col: Number(row.col), lines: Number(row.lines), container: row.container === null ? null : String(row.container) };
}

function indexedImports(context: Parameters<SemanticHandler>[0], files: readonly string[]): Import[] {
  if (!context.store) throw new DeclarationError('not-in-program', 'The TypeScript index is not available yet.');
  return files.length === 0 ? [] : query(context.store, 'MATCH (m:Declaration)-[e:IMPORTS]->(d:Declaration) WHERE m.file IN $files RETURN m.file AS file, e.line AS line, e.names AS names, d.file AS target UNION MATCH (m:Declaration)-[e:IMPORTS]->(external:External) WHERE m.file IN $files RETURN m.file AS file, e.line AS line, e.names AS names, external.module AS target', { files: [...files] })
    .map((row) => ({ path: String(row.file), line: Number(row.line), address: `${String(row.file)}:${Number(row.line)}:1`, name: String(row.names), target: String(row.target) }));
}

function select(items: readonly Declaration[], flags: Record<string, boolean | number | string | string[]>, depth: number, members = flags['--members'] === true): Declaration[] {
  const byContainer = membersByContainer(items);
  const roots = items.filter((item) => item.container === `${item.path}#<module>`);
  const out: Declaration[] = [];
  const visit = (item: Declaration, remaining: number) => {
    if (keep(item, flags)) out.push(item);
    if ((containers.has(item.kind) && (members || remaining > 1)) || (item.kind === 'function' && !members && remaining > 1)) for (const child of byContainer.get(item.key) ?? []) visit(child, members ? remaining : remaining - 1);
  };
  for (const item of roots) visit(item, depth);
  return out.sort(byPosition);
}

function keep(item: Declaration, flags: Record<string, boolean | number | string | string[]>): boolean {
  const kinds = flags['--kind'] as string[] | undefined;
  return (!kinds || kinds.includes(item.kind)) && (flags['--exported'] !== true || item.exported);
}

function symbolRow(root: string, symbol: Declaration, items: readonly Declaration[], flags: Record<string, boolean | number | string | string[]>): Row {
  const members = items.filter((item) => item.container === symbol.key && keep(item, flags)).length;
  const memberCount = containers.has(symbol.kind) ? `, ${members} members` : '';
  return { text: `${symbol.address}  ${symbol.kind}${symbol.exported ? '  export' : ''}  ${symbol.qualifiedName}  (${symbol.lines}L${memberCount})`, line: symbol.line, col: symbol.col, file: path.join(root, symbol.path) };
}

function importRow(item: Import): Row { return { text: `${item.address}  import  ${item.name}  ${item.target}`, line: item.line, col: 1 }; }

function containerRows(root: string, files: ReadonlyMap<string, Declaration[]>, imports: ReadonlyMap<string, Import[]>, flags: Record<string, boolean | number | string | string[]>, directory: string): Row[] {
  const grouped = new Map<string, Array<{ file: string; items: Declaration[] }>>();
  for (const [file, items] of files) {
    const relative = path.relative(directory, path.join(root, file)).split(path.sep).join('/');
    const parts = relative.split('/');
    const name = parts.length === 1 ? file : `${displayPath(root, path.join(directory, parts[0]!))}/`;
    grouped.set(name, [...(grouped.get(name) ?? []), { file, items }]);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, groups]) => {
    const count = groups.reduce((total, group) => total + select(group.items, flags, 1).length + (imports.get(group.file)?.length ?? 0), 0);
    const fileCount = groups.length;
    return { text: `${name}  (${fileCount} ${fileCount === 1 ? 'file' : 'files'}, ${count} symbols)`, line: 0, col: 0 };
  });
}

function byPosition(a: { line: number; col: number }, b: { line: number; col: number }): number { return a.line - b.line || a.col - b.col; }

export default handler;
