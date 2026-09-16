import { statSync } from 'node:fs';
import path from 'node:path';
import { escapeText } from '../../output.js';
import { DeclarationError } from '../../core/declarations.js';
import { TsServerError } from '../../server/tsserver.js';
import { isContainer, keep, lineCount, navtree, readSymbols, scopeFiles, type ReadSymbol } from '../../read/read.js';
import type { SemanticHandler } from '../handlers.js';

const handler: SemanticHandler = async (context, invocation) => {
  await context.projects.bootstrap();
  const started = performance.now();
  const flags = invocation.input.flags;
  const depth = flags['--depth'] as number;
  const scope = await scopeFiles(context, invocation.input.args);
  const directory = invocation.input.args.length === 0 ? context.root : invocation.input.args.map((input) => path.isAbsolute(input) ? input : path.resolve(context.root, input)).find((candidate) => {
    try { return statSync(candidate).isDirectory(); } catch { return false; }
  });
  const requestedDirectory = directory !== undefined || invocation.input.args.some((input) => /[*?[{]/.test(input));
  const files: FileSymbols[] = [];
  const explicitFiles = new Set(invocation.input.args.map((input) => path.isAbsolute(input) ? input : path.resolve(context.root, input)).filter((input) => {
    try { return statSync(input).isFile(); } catch { return false; }
  }));
  for (const file of scope.files) {
    const source = context.source.read(file);
    try {
      files.push({ file, source, symbols: readSymbols(context.root, file, await navtree(context, file), source) });
    } catch (error) {
      if (!(error instanceof TsServerError) || !error.message.includes('No Project')) throw error;
      if (explicitFiles.has(file)) throw new DeclarationError('not-in-program', `${path.relative(context.root, file).split(path.sep).join('/')} exists but is not part of a TypeScript project under ${context.root}.`);
      scope.notInProgram++;
    }
  }
  const rows = requestedDirectory && depth === 1
    ? containers(context.root, files, flags, directory ?? context.root)
    : symbols(files, flags, requestedDirectory ? depth - 1 : depth);
  const limit = flags['--limit'] as number | undefined;
  const shown = limit === undefined ? rows : rows.slice(0, limit);
  const symbolsCount = files.flatMap((file) => select(file.symbols, flags, requestedDirectory ? depth - 1 : depth, flags['--members'] === true)).length;
  const receipt = `${shown.length} outline row${shown.length === 1 ? '' : 's'}${limit !== undefined && rows.length > shown.length ? `, limit ${limit}` : ''}${scope.notInProgram > 0 ? `, ${scope.notInProgram} not in program` : ''}, ${Math.round(performance.now() - started)} ms`;
  return { element: 'outline', attributes: { path: invocation.input.args.join(' ') || '.', depth, symbols: symbolsCount, files: files.length }, body: shown.map((row) => row.text).join('\n'), count: shown.length, receipt };
};

interface FileSymbols { file: string; source: string; symbols: ReadSymbol[]; }
interface Row { text: string; }

function symbols(files: FileSymbols[], flags: Record<string, boolean | number | string | string[]>, depth: number): Row[] {
  return files.flatMap((file) => select(file.symbols, flags, depth, flags['--members'] === true).map((symbol) => ({ text: symbolRow(symbol, file.source, flags) })));
}

function select(items: ReadSymbol[], flags: Record<string, boolean | number | string | string[]>, depth: number, members: boolean): ReadSymbol[] {
  const out: ReadSymbol[] = [];
  for (const item of items) {
    if ((flags['--imports'] === true || item.kind !== 'alias') && keep(item, flags)) out.push(item);
    if (isContainer(item) && (members || depth > 1)) out.push(...select(item.children, flags, members ? depth : depth - 1, members));
  }
  return out.sort(byPosition);
}

function containers(root: string, files: FileSymbols[], flags: Record<string, boolean | number | string | string[]>, directory: string): Row[] {
  const grouped = new Map<string, FileSymbols[]>();
  for (const file of files) {
    const relative = path.relative(directory, file.file).split(path.sep).join('/');
    const parts = relative.split('/');
    const key = parts.length === 1 ? file.symbols[0]?.path ?? path.relative(root, file.file).split(path.sep).join('/') : `${path.relative(root, path.join(directory, parts[0]!)).split(path.sep).join('/')}/`; 
    grouped.set(key, [...(grouped.get(key) ?? []), file]);
  }
  return [...grouped.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, group]) => {
    const count = group.flatMap((file) => select(file.symbols, flags, 1, flags['--members'] === true)).length;
    return { text: `${escapeText(name)}  (${group.length} ${group.length === 1 ? 'file' : 'files'}, ${count} symbols)` };
  });
}

function symbolRow(symbol: ReadSymbol, source: string, flags: Record<string, boolean | number | string | string[]>): string {
  const modifiers = symbol.exported ? '  export' : '';
  const members = symbol.children.filter((child) => (flags['--imports'] === true || child.kind !== 'alias') && keep(child, flags)).length;
  const memberCount = isContainer(symbol) ? `, ${members} members` : '';
  return `${escapeText(symbol.address)}  ${symbol.kind}${modifiers}  ${escapeText(symbol.qualifiedName)}  (${lineCount(source, symbol.span)}L${memberCount})`;
}

function byPosition(a: ReadSymbol, b: ReadSymbol): number { return a.span.start.line - b.span.start.line || a.span.start.offset - b.span.start.offset; }

export default handler;
