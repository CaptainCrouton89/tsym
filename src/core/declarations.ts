import { existsSync } from 'node:fs';
import path from 'node:path';
import { query } from '../store/query.js';
import type { StoreRow } from '../store/store.js';
import { SourceReader, type SyntaxDeclaration } from './source.js';

export interface DeclarationAddress { path: string; line: number; col: number; }
export interface DeclarationRecord { address: string; location: DeclarationAddress; file: string; kind: string; name: string; qualifiedName: string; nameSpan: { start: number; end: number }; span: { start: number; end: number }; }
export class DeclarationError extends Error { constructor(readonly code: 'no-such-path' | 'not-in-program' | 'unresolvable-symbol' | 'ambiguous-symbol' | 'invalid-address', message: string, readonly candidates: string[] = []) { super(message); } }

/** Resolves every declaration identity from the committed index. */
export class DeclarationResolver {
  constructor(readonly root: string, readonly source: SourceReader, private readonly storeFor: () => import('../store/store.js').Store | undefined) {}

  async resolve(input: string): Promise<DeclarationRecord> {
    const address = parseAddress(input);
    return address ? this.resolveAddress(address) : this.resolveName(input);
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
    const declarations = this.rows(`MATCH (d:Declaration) WHERE d.file = $file AND d.line = $line AND d.col = $col RETURN ${columns()}`, { file: relativeFile, line: address.line, col: address.col });
    const references = declarations.length === 0
      ? this.rows(`MATCH (owner:Declaration)-[r:REFERENCES]->(d:Declaration) WHERE owner.file = $file AND r.line = $line AND r.col = $col RETURN ${columns()}`, { file: relativeFile, line: address.line, col: address.col })
      : [];
    const records = unique([...declarations, ...references].map((row) => this.record(row)));
    if (records.length === 0) {
      if (this.rows('MATCH (d:Declaration) WHERE d.file = $file AND d.line = 0 RETURN d.key AS key', { file: relativeFile }).length === 0) throw this.notInProgram(address.path);
      throw new DeclarationError('unresolvable-symbol', `${inputAddress(address)} does not resolve to a declaration`);
    }
    if (records.length > 1) throw new DeclarationError('ambiguous-symbol', `${inputAddress(address)} resolves to several declarations`, records.map((item) => item.address));
    return records[0]!;
  }

  async resolveName(name: string): Promise<DeclarationRecord> {
    const qualified = name.includes('.');
    const declarations = this.rows(`MATCH (d:Declaration) WHERE d.${qualified ? 'qname' : 'name'} = $name RETURN ${columns()}`, { name })
      .filter((row) => text(row, 'name') !== '<module>' && (qualified || !text(row, 'qname').includes('.')));
    const aliases = qualified ? [] : this.rows(`MATCH (:Declaration)-[e:EXPORTS]->(d:Declaration) WHERE e.name = $name RETURN ${columns()}`, { name });
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
    const nameStart = location.line === 0 ? 0 : offsetAt(source, location.line, location.col);
    const startLine = location.line === 0 ? 1 : number(row, 'endLine') - number(row, 'lines') + 1;
    const start = location.line === 0 ? 0 : offsetAt(source, startLine, 1);
    const end = location.line === 0 ? source.length : offsetAt(source, number(row, 'endLine') + 1, 1);
    return { address: inputAddress(location), location, file, kind: text(row, 'kind'), name: text(row, 'name'), qualifiedName: text(row, 'qname'), nameSpan: { start: nameStart, end: nameStart + text(row, 'name').length }, span: { start, end } };
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
function addressAt(source: string, offset: number, file: string): DeclarationAddress { const before = source.slice(0, offset); return { path: file, line: before.split('\n').length, col: before.length - before.lastIndexOf('\n') }; }
function text(row: StoreRow, key: string): string { return String(row[key] ?? ''); }
function number(row: StoreRow, key: string): number { return Number(row[key]); }
function unique(records: DeclarationRecord[]): DeclarationRecord[] { return [...new Map(records.map((record) => [record.address, record])).values()]; }
function columns(): string { return 'd.at AS at, d.name AS name, d.qname AS qname, d.kind AS kind, d.file AS file, d.line AS line, d.col AS col, d.endLine AS endLine, d.lines AS lines'; }
