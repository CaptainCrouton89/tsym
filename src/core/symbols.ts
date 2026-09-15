import { existsSync } from 'node:fs';
import { Node, SyntaxKind, type VariableDeclaration } from 'ts-morph';
import { find } from './find.js';
import { locOf, sourceFileFor } from './ts-program.js';
import type { Symbol } from './types.js';
import type { Workspace } from './workspace.js';

/** A symbol address as the CLI accepts it. */
export type Address = { kind: 'position'; path: string; line: number; col: number | null } | { kind: 'name'; name: string };

export class SymbolNotFound extends Error {
  constructor(address: string) {
    super(`no symbol matches ${address}`);
  }
}

export class EmptySymbolList extends Error {
  constructor() {
    super('at least one symbol is required');
  }
}

export class AmbiguousSymbol extends Error {
  readonly candidates: Symbol[];
  constructor(address: string, candidates: Symbol[]) {
    super(`${address} matches ${candidates.length} declarations; pick one with --path FILE or use its address:\n` + candidates.map((c) => `  ${formatAddress(c)}  ${c.kind} ${c.qualifiedName}`).join('\n'));
    this.candidates = candidates;
  }
}

export function formatAddress(s: Symbol): string {
  return `${s.path}:${s.namePos.line}:${s.namePos.col}`;
}

export function parseAddress(ws: Workspace, raw: string): Address {
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(raw);
  if (m && existsSync(ws.abs(m[1]!))) {
    return { kind: 'position', path: ws.rel(ws.abs(m[1]!)), line: Number(m[2]), col: m[3] ? Number(m[3]) : null };
  }
  return { kind: 'name', name: raw };
}

export interface ResolveOptions {
  /** Restrict a name lookup to one file. */
  path?: string;
}

export function asAddresses(addresses: string | readonly string[]): readonly string[] {
  const values = typeof addresses === 'string' ? [addresses] : addresses;
  if (values.length === 0) throw new EmptySymbolList();
  return values;
}

export function uniqueSymbols<T extends { path: string; start: { line: number; col: number } }>(symbols: readonly T[]): T[] {
  return [...new Map(symbols.map((symbol) => [`${symbol.path}:${symbol.start.line}:${symbol.start.col}`, symbol])).values()];
}

/** Resolve an address to exactly one declaration, or throw SymbolNotFound / AmbiguousSymbol. */
export async function resolveSymbol(ws: Workspace, raw: string, opts: ResolveOptions = {}): Promise<Symbol> {
  const address = parseAddress(ws, raw);
  if (address.kind === 'position') {
    const symbol = declarationAt(ws, address.path, address.line, address.col);
    if (symbol) return symbol;
    throw new SymbolNotFound(raw);
  }
  const inFile = opts.path ? ws.rel(ws.abs(opts.path)) : undefined;
  const found = (await find(ws, address.name, { in: inFile })).items;
  if (found.length === 0) throw new SymbolNotFound(raw);
  if (found.length === 1) return found[0]!;
  // A bare name that matches one top-level declaration plus same-named members: prefer the top-level one.
  const topLevel = found.filter((s) => s.qualifiedName === s.name);
  if (topLevel.length === 1) return topLevel[0]!;
  throw new AmbiguousSymbol(raw, found);
}

/** Resolve a position against its TypeScript declaration rather than the file-level outline. */
function declarationAt(ws: Workspace, path: string, line: number, col: number | null): Symbol | null {
  const source = sourceFileFor(ws, path);
  if (line === 0) {
    const loc = locOf(ws, source);
    return { ...loc, start: { line: 0, col: 0 }, kind: 'module', name: path.split('/').pop() ?? path, qualifiedName: path, exported: false, text: '(module scope)', namePos: loc.start };
  }
  const lineStarts = source.compilerNode.getLineStarts();
  const column = col ?? 1;
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || line > lineStarts.length || column < 1) return null;
  const position = lineStarts[line - 1]! + column - 1;
  const nextLine = line < lineStarts.length ? lineStarts[line]! : source.getFullText().length + 1;
  if (position >= nextLine) return null;
  let node = source.getDescendantAtPos(position);
  while (node) {
    const symbol = symbolForDeclaration(ws, node);
    if (symbol) return symbol;
    node = node.getParent();
  }
  return null;
}

function symbolForDeclaration(ws: Workspace, node: Node): Symbol | null {
  if (Node.isExportDeclaration(node)) {
    const specifier = node.getNamedExports()[0];
    const name = specifier?.getAliasNode()?.getText() ?? specifier?.getName() ?? 'export';
    return { ...namedSymbol(ws, node, 'export', name, undefined), exported: true };
  }
  if (Node.isVariableStatement(node)) {
    const declaration = node.getDeclarations()[0];
    return declaration ? variableSymbol(ws, declaration, node) : null;
  }
  if (Node.isVariableDeclaration(node)) {
    const statement = node.getVariableStatement();
    return variableSymbol(ws, node, statement?.getDeclarations().length === 1 ? statement : node);
  }
  if (Node.isFunctionDeclaration(node)) return namedSymbol(ws, node, 'function', node.getName() ?? 'default', node.getNameNode() ?? undefined);
  if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) return namedSymbol(ws, node, 'class', node.getName() ?? 'default', node.getNameNode() ?? undefined);
  if (Node.isInterfaceDeclaration(node)) return namedSymbol(ws, node, 'interface', node.getName(), node.getNameNode());
  if (Node.isTypeAliasDeclaration(node)) return namedSymbol(ws, node, 'type', node.getName(), node.getNameNode());
  if (Node.isEnumDeclaration(node)) return namedSymbol(ws, node, 'enum', node.getName(), node.getNameNode());
  if (Node.isModuleDeclaration(node)) return namedSymbol(ws, node, 'namespace', node.getName(), node.getNameNode());
  if (Node.isMethodDeclaration(node) || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) return namedSymbol(ws, node, 'method', node.getName(), node.getNameNode(), qualifiedName(node, node.getName()));
  if (Node.isPropertyDeclaration(node) || Node.isPropertySignature(node)) return namedSymbol(ws, node, 'property', node.getName(), node.getNameNode(), qualifiedName(node, node.getName()));
  if (Node.isMethodSignature(node)) return namedSymbol(ws, node, 'method', node.getName(), node.getNameNode(), qualifiedName(node, node.getName()));
  if (Node.isEnumMember(node)) return namedSymbol(ws, node, 'property', node.getName(), node.getNameNode(), qualifiedName(node, node.getName()));
  if (Node.isConstructorDeclaration(node)) {
    const owner = node.getParent();
    const nameNode = Node.isClassDeclaration(owner) || Node.isClassExpression(owner) ? owner.getNameNode() ?? undefined : undefined;
    return namedSymbol(ws, node, 'method', 'constructor', nameNode, qualifiedName(node, 'constructor'));
  }
  if (Node.isPropertyAssignment(node)) {
    const initializer = node.getInitializer();
    if (initializer && isFunctionLike(initializer)) return namedSymbol(ws, node, 'function', node.getName(), node.getNameNode(), qualifiedName(node, node.getName()));
  }
  return null;
}

function variableSymbol(ws: Workspace, declaration: VariableDeclaration, range: Node): Symbol {
  const initializer = declaration.getInitializer();
  return namedSymbol(ws, range, initializer && isFunctionLike(initializer) ? 'function' : 'var', declaration.getName(), declaration.getNameNode());
}

function isFunctionLike(node: Node): boolean {
  return Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isConstructorDeclaration(node) || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node);
}

function namedSymbol(ws: Workspace, node: Node, kind: Symbol['kind'], name: string, nameNode: Node | undefined, qualified = qualifiedName(node, name)): Symbol {
  const loc = locOf(ws, node);
  return { ...loc, kind, name, qualifiedName: qualified, exported: hasExportKeyword(node), text: node.getText().split('\n')[0]!.trim(), namePos: nameNode ? locOf(ws, nameNode).start : loc.start };
}

function hasExportKeyword(node: Node): boolean {
  return Node.isModifierable(node) && node.hasModifier(SyntaxKind.ExportKeyword);
}

function qualifiedName(node: Node, name: string): string {
  const scopes: string[] = [];
  for (let owner = node.getParent(); owner; owner = owner.getParent()) {
    if (Node.isClassDeclaration(owner) || Node.isClassExpression(owner) || Node.isInterfaceDeclaration(owner) || Node.isEnumDeclaration(owner) || Node.isModuleDeclaration(owner)) {
      scopes.unshift(owner.getName() ?? '(class)');
    } else if (Node.isObjectLiteralExpression(owner)) {
      const holder = owner.getParent();
      if (Node.isVariableDeclaration(holder)) scopes.unshift(holder.getName());
    }
  }
  return [...scopes, name].join('.');
}
