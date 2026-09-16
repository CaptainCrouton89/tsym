import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { DeclarationError } from '../core/declarations.js';
import { matchesPathFilters } from '../core/receipt.js';
import { openWorkspace } from '../core/workspace.js';
import type { SemanticContext } from '../server/context.js';

export interface Position { line: number; offset: number; }
export interface Span { start: Position; end: Position; }
export interface ReadSymbol { address: string; path: string; name: string; qualifiedName: string; kind: string; exported: boolean; span: Span; children: ReadSymbol[]; }

const containers = new Set(['class', 'interface', 'enum', 'namespace']);
const extensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

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

export function isContainer(symbol: ReadSymbol): boolean { return containers.has(symbol.kind); }
export function keep(symbol: ReadSymbol, flags: Record<string, boolean | number | string | string[]>): boolean {
  const kinds = flags['--kind'] as string[] | undefined;
  return (!kinds || kinds.includes(symbol.kind)) && (flags['--exported'] !== true || symbol.exported) && matchesPathFilters(symbol.path, { in: flags['--in'] as string[] | undefined, exclude: flags['--exclude'] as string[] | undefined });
}

/** Operands resolve from the client cwd; an empty operand list means the workspace root. */
export async function scopeFiles(context: SemanticContext, cwd: string, inputs: readonly string[]): Promise<{ files: string[]; notInProgram: number }> {
  const workspace = openWorkspace(context.root);
  const listed = workspace.files().filter((file) => extensions.has(path.extname(file)));
  const selected = new Set<string>();
  for (const input of inputs.length === 0 ? [context.root] : inputs) {
    const absolute = path.resolve(cwd, input);
    const relative = displayPath(context.root, absolute);
    const glob = /[*?[{]/.test(input);
    if (existsSync(absolute)) {
      const stat = statSync(absolute);
      if (stat.isFile()) {
        if (!extensions.has(path.extname(absolute))) throw new DeclarationError('not-in-program', `${input} is not a TypeScript-family source file`);
        const membership = await context.projects.membership(absolute);
        if (!membership) throw new DeclarationError('not-in-program', `${input} exists but is not part of a TypeScript project under ${context.root}`);
        selected.add(displayPath(context.root, absolute));
      } else if (stat.isDirectory()) {
        for (const file of listed) if (relative === '' || file === relative || file.startsWith(`${relative.replace(/\/$/, '')}/`)) selected.add(file);
      }
    } else if (glob) {
      for (const file of listed) if (workspace.files(relative).includes(file)) selected.add(file);
    } else throw new DeclarationError('no-such-path', `${input} does not exist`);
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

export function sourceSpan(source: string, span: Span): string { return source.slice(positionOffset(source, span.start), positionOffset(source, span.end)); }

export function declarationText(source: string, span: Span, kind: string): string {
  if (!['const', 'let', 'var'].includes(kind)) return sourceSpan(source, span);
  const start = positionOffset(source, span.start);
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const prefix = source.slice(lineStart, start);
  const end = positionOffset(source, span.end);
  const statementEnd = source.indexOf(';', end);
  return /^(\s*)(?:export\s+)?(?:declare\s+)?(?:const|let|var)\b/.test(prefix) ? source.slice(lineStart, statementEnd < 0 ? end : statementEnd + 1) : sourceSpan(source, span);
}

export function normalKind(kind: string): string { return kind === 'module' ? 'namespace' : kind; }
