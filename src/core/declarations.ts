import { existsSync } from 'node:fs';
import path from 'node:path';
import { query } from '../store/query.js';
import type { StoreRow } from '../store/store.js';
import { SourceReader, type SyntaxDeclaration } from './source.js';

export interface DeclarationAddress { path: string; line: number; col: number; }
export interface DeclarationRecord { address: string; location: DeclarationAddress; file: string; kind: string; name: string; qualifiedName: string; nameSpan: { start: number; end: number }; span: { start: number; end: number }; }
export class DeclarationError extends Error { constructor(readonly code: 'no-such-path' | 'not-in-program' | 'unresolvable-symbol' | 'ambiguous-symbol' | 'invalid-address', message: string, readonly candidates: string[] = []) { super(message); } }
export class DeclarationResolutionErrors extends Error { constructor(readonly errors: readonly DeclarationError[]) { super(errors.map((error) => error.message).join('\n')); } }

/** Resolves every declaration identity from the committed index. */
export class DeclarationResolver {
  constructor(readonly root: string, readonly source: SourceReader, private readonly storeFor: () => import('../store/store.js').Store | undefined) {}

  async resolve(input: string): Promise<DeclarationRecord> {
    const address = parseAddress(input);
    return address ? this.resolveAddress(address) : this.resolveName(input);
  }

  async resolveAll(inputs: readonly string[]): Promise<DeclarationRecord[]> {
    const records: DeclarationRecord[] = [];
    const errors: DeclarationError[] = [];
    for (const input of inputs) {
      try { records.push(await this.resolve(input)); }
      catch (error) {
        if (error instanceof DeclarationError) errors.push(error);
        else throw error;
      }
    }
    if (errors.length > 0) throw new DeclarationResolutionErrors(errors);
    return records;
  }

  async resolveAddress(address: DeclarationAddress): Promise<DeclarationRecord> {
    const file = path.resolve(this.root, address.path);
    if (!existsSync(file)) throw new DeclarationError('no-such-path', `${address.path} does not exist`);
    if (address.line === 0 || address.col === 0) {
      if (address.line !== 0 || address.col !== 0) throw new DeclarationError('invalid-address', `${inputAddress(address)} mixes zero module coordinates with a source position`);
      const module = this.rows(`MATCH (d:Declaration) WHERE d.file = $file AND d.line = 0 AND d.col = 0 RETURN ${columns()}`, { file: relative(this.root, file) });
      if (module.length === 0) throw this.notInProgram(address.path);
      return this.record(module[0]!);
    }
    this.validatePosition(address, file);
    const relativeFile = relative(this.root, file);
    const source = this.source.read(file);
    const position = offsetAt(source, address.line, address.col);
    const declarations = this.rows(`MATCH (d:Declaration) WHERE d.file = $file AND d.line = $line RETURN ${columns()}`, { file: relativeFile, line: address.line })
      .filter((row) => {
        const nameSpan = this.source.declarationNameSpanAt(file, number(row, 'line'), number(row, 'col'));
        return nameSpan !== null && nameSpan.start <= position && position < nameSpan.end;
      });
    const references = declarations.length === 0
      ? this.rows(`MATCH (owner:Declaration)-[r:REFERENCES]->(d:Declaration) WHERE owner.file = $file AND r.line = $line AND r.col <= $col RETURN ${columns()}, r.col AS referenceCol`, { file: relativeFile, line: address.line, col: address.col })
        .filter((row) => address.col < number(row, 'referenceCol') + identifierLengthAt(source, address.line, number(row, 'referenceCol')))
      : [];
    const enclosing = declarations.length === 0 && references.length === 0
      ? this.rows(`MATCH (d:Declaration) WHERE d.file = $file AND d.line > 0 AND d.endLine - d.lines + 1 <= $line AND $line <= d.endLine RETURN ${columns()}`, { file: relativeFile, line: address.line })
        .flatMap((row) => {
          const span = this.source.declarationSpanAt(file, number(row, 'line'), number(row, 'col'));
          return span && span.start <= position && position < span.end ? [{ row, span }] : [];
        })
        .sort((left, right) => left.span.end - left.span.start - (right.span.end - right.span.start) || right.span.start - left.span.start)
        .slice(0, 1)
        .map(({ row }) => row)
      : [];
    const records = unique((declarations.length > 0 ? declarations : references.length > 0 ? references : enclosing).map((row) => this.record(row)));
    if (records.length === 0) {
      if (this.rows('MATCH (d:Declaration) WHERE d.file = $file AND d.line = 0 RETURN d.key AS key', { file: relativeFile }).length === 0) throw this.notInProgram(address.path);
      throw new DeclarationError('unresolvable-symbol', this.unresolvableAddress(address, relativeFile));
    }
    if (records.length > 1) throw new DeclarationError('ambiguous-symbol', `${inputAddress(address)} resolves to several declarations`, records.map((item) => item.address));
    return records[0]!;
  }

  async resolveName(name: string): Promise<DeclarationRecord> {
    const qualified = name.includes('.');
    const declarations = this.rows(`MATCH (d:Declaration) WHERE d.${qualified ? 'qname' : 'name'} = $name RETURN ${columns()}`, { name })
      .filter((row) => text(row, 'name') !== '<module>' && (qualified || text(row, 'container').endsWith('#<module>')));
    const aliases = qualified ? [] : this.rows(`MATCH (:Declaration)-[e:EXPORTS]->(d:Declaration) WHERE e.name = $name RETURN ${columns()}`, { name })
      .filter((row) => text(row, 'container').endsWith('#<module>'));
    const normalized = unique([...declarations, ...aliases].map((row) => this.record(row)));
    if (normalized.length === 0) throw new DeclarationError('unresolvable-symbol', `No declaration matches ${name}`);
    if (normalized.length > 1) throw new DeclarationError('ambiguous-symbol', `${name} is ambiguous`, normalized.map((item) => item.address));
    return normalized[0]!;
  }

  fromSyntax(file: string, declaration: SyntaxDeclaration): DeclarationRecord {
    const location = declaration.kind === 'module' ? { path: relative(this.root, file), line: 0, col: 0 } : addressAt(this.source.read(file), declaration.nameSpan.start, relative(this.root, file));
    return { address: inputAddress(location), location, file, kind: declaration.kind, name: declaration.name, qualifiedName: declaration.containerName ? `${declaration.containerName}.${declaration.name}` : declaration.name, nameSpan: declaration.nameSpan, span: declaration.span };
  }

  private rows(cypher: string, parameters: Record<string, string | number> = {}): StoreRow[] {
    const store = this.storeFor();
    if (!store) throw new DeclarationError('not-in-program', 'The TypeScript index is not available yet.');
    return query(store, cypher, parameters);
  }

  private record(row: StoreRow): DeclarationRecord {
    const location = { path: text(row, 'file'), line: number(row, 'line'), col: number(row, 'col') };
    const file = path.join(this.root, location.path);
    const source = this.source.read(file);
    const name = location.line === 0 ? path.basename(file) : text(row, 'name');
    const nameStart = location.line === 0 ? 0 : offsetAt(source, location.line, location.col);
    const startLine = location.line === 0 ? 1 : number(row, 'endLine') - number(row, 'lines') + 1;
    const start = location.line === 0 ? 0 : offsetAt(source, startLine, 1);
    const end = location.line === 0 ? source.length : offsetAt(source, number(row, 'endLine') + 1, 1);
    return { address: inputAddress(location), location, file, kind: text(row, 'kind'), name, qualifiedName: location.line === 0 ? name : text(row, 'qname'), nameSpan: { start: nameStart, end: nameStart + name.length }, span: { start, end } };
  }

  private unresolvableAddress(address: DeclarationAddress, file: string): string {
    const topLevel = this.rows('MATCH (d:Declaration) WHERE d.file = $file AND d.line > 0 AND d.container = $module RETURN d.at AS at, d.kind AS kind, d.qname AS qname ORDER BY d.line, d.col', { file, module: `${file}#<module>` });
    const shown = topLevel.slice(0, 20);
    const tail = topLevel.length > shown.length ? `\n+${topLevel.length - shown.length} more, run outline ${file}` : '';
    return `${inputAddress(address)} does not resolve to a declaration.\nModule: ${file}:0:0\nTop-level declarations:\n${shown.map((row) => `${text(row, 'at')}  ${text(row, 'kind')}  ${text(row, 'qname')}`).join('\n')}${tail}`;
  }

  private validatePosition(address: DeclarationAddress, file: string): void {
    const lines = this.source.read(file).split('\n');
    if (address.line < 1 || address.col < 1 || address.line > lines.length || address.col > lines[address.line - 1]!.length + 1) throw new DeclarationError('invalid-address', `${inputAddress(address)} is outside the source text`);
  }

  private notInProgram(file: string): DeclarationError { return new DeclarationError('not-in-program', `${file} exists but is not part of a TypeScript project under ${this.root}`); }
}

function parseAddress(value: string): DeclarationAddress | null { const match = /^(.*):(\d+):(\d+)$/.exec(value); return match ? { path: match[1]!, line: Number(match[2]), col: Number(match[3]) } : null; }
function inputAddress(address: DeclarationAddress): string { return `${address.path}:${address.line}:${address.col}`; }
function relative(root: string, file: string): string { return path.relative(root, file).split(path.sep).join('/'); }
function offsetAt(source: string, line: number, col: number): number { const lines = source.split('\n'); return lines.slice(0, Math.max(0, line - 1)).reduce((offset, value) => offset + value.length + 1, 0) + Math.max(0, col - 1); }
function identifierLengthAt(source: string, line: number, col: number): number { return /^(?:[$_\p{ID_Start}]|\\u[0-9A-Fa-f]{4}|\\u\{[0-9A-Fa-f]+\})(?:[$_\p{ID_Continue}\u200C\u200D]|\\u[0-9A-Fa-f]{4}|\\u\{[0-9A-Fa-f]+\})*/u.exec(source.slice(offsetAt(source, line, col)))?.[0].length ?? 0; }
function addressAt(source: string, offset: number, file: string): DeclarationAddress { const before = source.slice(0, offset); return { path: file, line: before.split('\n').length, col: before.length - before.lastIndexOf('\n') }; }
function text(row: StoreRow, key: string): string { return String(row[key] ?? ''); }
function number(row: StoreRow, key: string): number { return Number(row[key]); }
function unique(records: DeclarationRecord[]): DeclarationRecord[] { return [...new Map(records.map((record) => [record.address, record])).values()]; }
function columns(): string { return 'd.at AS at, d.name AS name, d.qname AS qname, d.kind AS kind, d.file AS file, d.line AS line, d.col AS col, d.endLine AS endLine, d.lines AS lines, d.container AS container'; }
