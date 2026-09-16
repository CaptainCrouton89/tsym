import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type * as ts from 'typescript';

export interface SourceSpan { start: number; end: number; }
export interface SyntaxDeclaration { name: string; kind: string; nameSpan: SourceSpan; span: SourceSpan; containerName?: string; }

/** Syntax-only reader loaded from the same compiler installation as tsserver. */
export class SourceReader {
  private readonly compiler: typeof ts;
  constructor(tsserverPath: string) { this.compiler = createRequire(import.meta.url)(tsserverPath.replace(/tsserver\.js$/, 'typescript.js')) as typeof ts; }
  read(file: string): string { return readFileSync(file, 'utf8'); }
  declarationAt(file: string, line: number, offset: number): SyntaxDeclaration | null {
    const source = this.parse(file);
    return declarationAt(this.tokenAt(source, source.getPositionOfLineAndCharacter(line - 1, offset - 1)), source, this.compiler);
  }
  declarationForSpan(file: string, start: { line: number; offset: number }): SyntaxDeclaration | null { return this.declarationAt(file, start.line, start.offset); }
  ownerForSpan(file: string, start: { line: number; offset: number }): SyntaxDeclaration {
    const source = this.parse(file);
    return ownerAt(this.tokenAt(source, source.getPositionOfLineAndCharacter(start.line - 1, start.offset - 1)), source, this.compiler) ?? moduleFor(source);
  }
  module(file: string): SyntaxDeclaration { return moduleFor(this.parse(file)); }
  private parse(file: string): ts.SourceFile { return this.compiler.createSourceFile(file, this.read(file), this.compiler.ScriptTarget.Latest, true, scriptKind(file, this.compiler)); }
  private tokenAt(source: ts.SourceFile, position: number): ts.Node {
    let current: ts.Node = source;
    for (;;) {
      const child = current.forEachChild((candidate) => position >= candidate.getFullStart() && position < candidate.getEnd() ? candidate : undefined);
      if (!child) return current;
      current = child;
    }
  }
}

function declarationAt(node: ts.Node, source: ts.SourceFile, compiler: typeof ts): SyntaxDeclaration | null {
  let current: ts.Node | undefined = node;
  while (current) {
    const declaration = declarationFor(current, compiler);
    if (declaration) return describe(declaration, source, compiler);
    current = current.parent;
  }
  return null;
}

function ownerAt(node: ts.Node, source: ts.SourceFile, compiler: typeof ts): SyntaxDeclaration | null {
  let current: ts.Node | undefined = node;
  let insideUnnamedCallback = false;
  for (let ancestor = current; ancestor; ancestor = ancestor.parent) if (isUnnamedCallback(ancestor, compiler)) insideUnnamedCallback = true;
  while (current) {
    const declaration = declarationFor(current, compiler);
    if (declaration && (!insideUnnamedCallback || namedCallable(declaration, compiler))) return describe(declaration, source, compiler);
    current = current.parent;
  }
  return null;
}

function declarationFor(node: ts.Node, compiler: typeof ts): ts.Declaration | null {
  if (compiler.isVariableDeclaration(node) || compiler.isFunctionDeclaration(node) || compiler.isFunctionExpression(node) || compiler.isClassDeclaration(node) || compiler.isInterfaceDeclaration(node) || compiler.isTypeAliasDeclaration(node) || compiler.isEnumDeclaration(node) || compiler.isMethodDeclaration(node) || compiler.isPropertyDeclaration(node) || compiler.isGetAccessorDeclaration(node) || compiler.isSetAccessorDeclaration(node) || compiler.isParameter(node) || compiler.isImportSpecifier(node) || compiler.isExportSpecifier(node)) return node;
  return null;
}

function isUnnamedCallback(node: ts.Node, compiler: typeof ts): boolean {
  if (compiler.isArrowFunction(node)) return true;
  return compiler.isFunctionExpression(node) && !node.name;
}

function namedCallable(node: ts.Declaration, compiler: typeof ts): boolean {
  if (compiler.isVariableDeclaration(node) || compiler.isPropertyDeclaration(node)) return !!node.name && !!node.initializer && (compiler.isArrowFunction(node.initializer) || compiler.isFunctionExpression(node.initializer));
  return (compiler.isFunctionDeclaration(node) || compiler.isFunctionExpression(node) || compiler.isMethodDeclaration(node) || compiler.isGetAccessorDeclaration(node) || compiler.isSetAccessorDeclaration(node)) && !!node.name;
}

function describe(node: ts.Declaration, source: ts.SourceFile, compiler: typeof ts): SyntaxDeclaration | null {
  const named = node as ts.NamedDeclaration;
  const name = named.name;
  if (!name || !compiler.isIdentifier(name) && !compiler.isPrivateIdentifier(name) && !compiler.isStringLiteral(name)) return null;
  const parent = node.parent;
  const container = parent && (compiler.isClassDeclaration(parent) || compiler.isInterfaceDeclaration(parent) || compiler.isEnumDeclaration(parent)) && parent.name ? parent.name.text : undefined;
  return { name: name.text, kind: compiler.SyntaxKind[node.kind] ?? 'unknown', nameSpan: { start: name.getStart(source), end: name.getEnd() }, span: { start: node.getStart(source), end: node.getEnd() }, containerName: container };
}

function moduleFor(source: ts.SourceFile): SyntaxDeclaration {
  return { name: path.basename(source.fileName), kind: 'module', nameSpan: { start: 0, end: 0 }, span: { start: 0, end: source.end } };
}

function scriptKind(file: string, compiler: typeof ts): ts.ScriptKind {
  if (file.endsWith('.tsx')) return compiler.ScriptKind.TSX;
  if (file.endsWith('.js') || file.endsWith('.mjs') || file.endsWith('.cjs')) return compiler.ScriptKind.JS;
  return compiler.ScriptKind.TS;
}
