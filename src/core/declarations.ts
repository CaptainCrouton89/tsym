import { existsSync } from 'node:fs';
import path from 'node:path';
import type { ProjectRegistry } from '../server/projects.js';
import type { FilePosition, TsServerSession } from '../server/tsserver.js';
import { SourceReader, type SyntaxDeclaration } from './source.js';

export interface DeclarationAddress { path: string; line: number; col: number; }
export interface DeclarationRecord { address: string; location: DeclarationAddress; file: string; kind: string; name: string; qualifiedName: string; nameSpan: { start: number; end: number }; span: { start: number; end: number }; }
export class DeclarationError extends Error { constructor(readonly code: 'no-such-path' | 'not-in-program' | 'unresolvable-symbol' | 'ambiguous-symbol' | 'invalid-address', message: string, readonly candidates: string[] = []) { super(message); } }

/** The only semantic identity normalizer. Every identity is a declaration name span. */
export class DeclarationResolver {
  constructor(readonly root: string, readonly session: TsServerSession, readonly projects: ProjectRegistry, readonly source: SourceReader) {}

  async resolve(input: string): Promise<DeclarationRecord> {
    const address = parseAddress(input);
    return address ? this.resolveAddress(address) : this.resolveName(input);
  }

  async resolveAddress(address: DeclarationAddress): Promise<DeclarationRecord> {
    const file = path.resolve(this.root, address.path);
    if (!existsSync(file)) throw new DeclarationError('no-such-path', `${address.path} does not exist.`);
    const project = await this.projects.membership(file);
    if (!project) throw new DeclarationError('not-in-program', `${address.path} exists but is not part of a TypeScript project under ${this.root}.`);
    if (address.line === 0 && address.col === 0) return this.fromSyntax(file, this.source.module(file));
    if (address.line === 0 || address.col === 0) throw new DeclarationError('invalid-address', `${inputAddress(address)} mixes zero module coordinates with a source position.`);
    const body = await this.session.definition({ file, line: address.line, offset: address.col });
    const definitions = definitionFiles(body);
    const normalized = unique(await Promise.all(definitions.map((definition) => this.fromFileSpan(definition))));
    if (normalized.length === 0) throw new DeclarationError('unresolvable-symbol', `${inputAddress(address)} does not resolve to a declaration.`);
    if (normalized.length > 1) throw new DeclarationError('ambiguous-symbol', `${inputAddress(address)} resolves to several declarations.`, normalized.map((item) => item.address));
    return normalized[0]!;
  }

  async resolveName(name: string): Promise<DeclarationRecord> {
    const qualified = name.includes('.');
    const body = await this.session.navto(name);
    const raw = Array.isArray(body) ? body as NavtoItem[] : [];
    const matching = raw.filter((item) => item.name === name || qualified && `${item.containerName ?? ''}.${item.name}` === name).filter((item) => qualified || !item.containerName);
    const normalized = unique(await Promise.all(matching.map(async (item) => {
      const file = path.resolve(item.file);
      return this.resolveAddress({ path: relative(this.root, file), line: item.start.line, col: item.start.offset });
    })));
    if (normalized.length === 0) throw new DeclarationError('unresolvable-symbol', `No declaration matches ${name}.`);
    if (normalized.length > 1) throw new DeclarationError('ambiguous-symbol', `${name} is ambiguous.`, normalized.map((item) => item.address));
    return normalized[0]!;
  }

  async fromFileSpan(span: FileSpan): Promise<DeclarationRecord> {
    return this.fromSyntax(span.file, requireDeclaration(this.source.declarationForSpan(span.file, span.start), span.file));
  }

  fromSyntax(file: string, declaration: SyntaxDeclaration): DeclarationRecord {
    const location = declaration.kind === 'module' ? { path: relative(this.root, file), line: 0, col: 0 } : offsetAddress(this.source.read(file), declaration.nameSpan.start, relative(this.root, file));
    return { address: inputAddress(location), location, file, kind: declaration.kind, name: declaration.name, qualifiedName: declaration.containerName ? `${declaration.containerName}.${declaration.name}` : declaration.name, nameSpan: declaration.nameSpan, span: declaration.span };
  }
}

interface FileSpan { file: string; start: { line: number; offset: number }; end?: { line: number; offset: number }; }
interface NavtoItem extends FileSpan { name: string; containerName?: string; }
function definitionFiles(body: unknown): FileSpan[] { return Array.isArray((body as { definitions?: unknown })?.definitions) ? (body as { definitions: FileSpan[] }).definitions : []; }
function requireDeclaration(value: SyntaxDeclaration | null, file: string): SyntaxDeclaration { if (!value) throw new DeclarationError('unresolvable-symbol', `TypeScript returned a location in ${file} that has no named declaration.`); return value; }
function parseAddress(value: string): DeclarationAddress | null { const match = /^(.*):(\d+):(\d+)$/.exec(value); return match ? { path: match[1]!, line: Number(match[2]), col: Number(match[3]) } : null; }
function inputAddress(address: DeclarationAddress): string { return `${address.path}:${address.line}:${address.col}`; }
function relative(root: string, file: string): string { return path.relative(root, file).split(path.sep).join('/'); }
function offsetAddress(source: string, offset: number, file: string): DeclarationAddress { const before = source.slice(0, offset); const line = before.split('\n').length; const col = before.length - before.lastIndexOf('\n'); return { path: file, line, col }; }
function unique(records: DeclarationRecord[]): DeclarationRecord[] { return [...new Map(records.map((record) => [record.address, record])).values()]; }
