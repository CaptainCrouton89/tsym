import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DeclarationError, type DeclarationRecord } from '../core/declarations.js';
import { matchesPathFilters } from '../core/receipt.js';
import { openWorkspace } from '../core/workspace.js';
import type { SemanticContext } from '../server/context.js';

export interface Position { line: number; offset: number; }
export interface Span { start: Position; end: Position; }
export interface NavtreeItem { text: string; kind: string; kindModifiers: string; spans: Span[]; nameSpan?: Span; childItems?: NavtreeItem[]; }
export interface NavtoItem { name: string; kind: string; kindModifiers: string; file: string; start: Position; end: Position; containerName?: string; }
export interface ReadSymbol { address: string; path: string; name: string; qualifiedName: string; kind: string; exported: boolean; span: Span; nameSpan?: Span; children: ReadSymbol[]; }

const containers = new Set(['class', 'interface', 'enum', 'module']);
const extensions = new Set(['.ts', '.tsx', '.mts', '.cts']);

export function displayPath(root: string, file: string): string { return path.relative(root, file).split(path.sep).join('/'); }

export function positionOffset(source: string, position: Position): number {
  let line = 1;
  let offset = 0;
  while (line < position.line && offset < source.length) { const newline = source.indexOf('\n', offset); offset = newline < 0 ? source.length : newline + 1; line++; }
  return offset + position.offset - 1;
}

export function lineCount(source: string, span: Span): number {
  const start = positionOffset(source, span.start);
  const end = positionOffset(source, span.end);
  return source.slice(start, end).split('\n').length - (end > start && source[end - 1] === '\n' ? 1 : 0);
}

export async function navtree(context: SemanticContext, file: string): Promise<NavtreeItem> { return await context.session.navtree(file) as NavtreeItem; }
export async function navto(context: SemanticContext, name: string): Promise<NavtoItem[]> { const body = await context.session.navto(name); return Array.isArray(body) ? body as NavtoItem[] : []; }

export function readSymbols(root: string, file: string, tree: NavtreeItem, source: string): ReadSymbol[] {
  const visit = (item: NavtreeItem, container?: string): ReadSymbol | null => {
    const span = item.spans[0];
    if (!span) return null;
    const kind = normalizeKind(item.kind);
    const name = item.text;
    const nameSpan = item.nameSpan;
    const address = nameSpan ? `${displayPath(root, file)}:${nameSpan.start.line}:${nameSpan.start.offset}` : `${displayPath(root, file)}:${span.start.line}:${span.start.offset}`;
    const children = (item.childItems ?? []).map((child) => visit(child, nameSpan ? name : container)).filter((child): child is ReadSymbol => child !== null);
    return { address, path: displayPath(root, file), name, qualifiedName: container ? `${container}.${name}` : name, kind, exported: item.kindModifiers.split(/[\s,]+/).includes('export'), span, nameSpan, children };
  };
  return (tree.childItems ?? []).map((item) => visit(item)).filter((item): item is ReadSymbol => item !== null);
}

export function normalKind(kind: string): string { return normalizeKind(kind); }
export function isContainer(symbol: ReadSymbol): boolean { return containers.has(symbol.kind); }
export function keep(symbol: ReadSymbol, flags: Record<string, boolean | number | string | string[]>): boolean {
  const kinds = flags['--kind'] as string[] | undefined;
  return (!kinds || kinds.includes(symbol.kind)) && (flags['--exported'] !== true || symbol.exported) && matchesPathFilters(symbol.path, { in: flags['--in'] as string[] | undefined, exclude: flags['--exclude'] as string[] | undefined });
}

export async function scopeFiles(context: SemanticContext, inputs: readonly string[]): Promise<{ files: string[]; notInProgram: number }> {
  const workspace = openWorkspace(context.root);
  const listed = workspace.files().filter((file) => extensions.has(path.extname(file)));
  const selected = new Set<string>();
  for (const input of inputs.length === 0 ? ['.'] : inputs) {
    const absolute = path.isAbsolute(input) ? input : path.resolve(context.root, input);
    const rel = displayPath(context.root, absolute);
    const glob = /[*?[{]/.test(input);
    if (existsSync(absolute)) {
      const stat = statSync(absolute);
      if (stat.isFile()) {
        if (!extensions.has(path.extname(absolute))) throw new DeclarationError('not-in-program', `${input} is not a TypeScript-family source file.`);
        const membership = await context.projects.membership(absolute);
        if (!membership) throw new DeclarationError('not-in-program', `${input} exists but is not part of a TypeScript project under ${context.root}.`);
        selected.add(displayPath(context.root, absolute));
      } else if (stat.isDirectory()) {
        for (const file of listed) if (rel === '' || file === rel || file.startsWith(`${rel.replace(/\/$/, '')}/`)) selected.add(file);
      }
    } else if (glob) {
      for (const file of listed) if (workspace.files(input).includes(file)) selected.add(file);
    } else throw new DeclarationError('no-such-path', `${input} does not exist.`);
  }
  let notInProgram = 0;
  const files: string[] = [];
  for (const relative of [...selected].sort()) {
    const absolute = path.join(context.root, relative);
    if (await context.projects.membership(absolute)) files.push(absolute);
    else notInProgram++;
  }
  return { files, notInProgram };
}

export function declarationSpans(tree: NavtreeItem, record: DeclarationRecord): Span[] {
  if (record.location.line === 0) return [];
  const found: Span[] = [];
  const visit = (item: NavtreeItem) => {
    if (item.nameSpan?.start.line === record.location.line && item.nameSpan.start.offset === record.location.col) found.push(...item.spans);
    for (const child of item.childItems ?? []) visit(child);
  };
  visit(tree);
  return found.length > 0 ? found.sort((a, b) => a.start.line - b.start.line || a.start.offset - b.start.offset) : [{ start: { line: record.location.line, offset: record.location.col }, end: { line: record.location.line, offset: record.location.col } }];
}

export function sourceSpan(source: string, span: Span): string { return source.slice(positionOffset(source, span.start), positionOffset(source, span.end)); }

export function declarationText(source: string, span: Span, kind: string): string {
  if (!['const', 'let', 'var'].includes(kind)) return sourceSpan(source, span);
  const start = positionOffset(source, span.start);
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const prefix = source.slice(lineStart, start);
  const end = positionOffset(source, span.end);
  return /^(\s*)(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+$/.test(prefix) ? source.slice(lineStart, end + (source[end] === ';' ? 1 : 0)) : sourceSpan(source, span);
}

function normalizeKind(kind: string): string {
  const declarations: Record<string, string> = { FunctionDeclaration: 'function', ClassDeclaration: 'class', InterfaceDeclaration: 'interface', TypeAliasDeclaration: 'type', EnumDeclaration: 'enum', VariableDeclaration: 'const', MethodDeclaration: 'method', PropertyDeclaration: 'property', GetAccessor: 'getter', SetAccessor: 'setter', Constructor: 'constructor', ModuleDeclaration: 'module', ImportSpecifier: 'alias', ExportSpecifier: 'alias' };
  if (kind === 'alias') return 'alias';
  if (kind === 'enum member') return 'property';
  return Object.prototype.hasOwnProperty.call(declarations, kind) ? declarations[kind]! : kind;
}
