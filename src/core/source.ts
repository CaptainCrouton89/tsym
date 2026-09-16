import { readFileSync } from 'node:fs';
import path from 'node:path';
import * as ts from '../ts7/ast.js';
import type { ProjectRegistry } from '../server/projects.js';

export interface SourceSpan { start: number; end: number; }
export interface SyntaxDeclaration { name: string; kind: string; nameSpan: SourceSpan; span: SourceSpan; containerName?: string; }

/** Syntax-only reader backed by the resident TypeScript 7 snapshot. */
export class SourceReader {
  private readonly projects: Pick<ProjectRegistry, 'refreshFile' | 'sourceFile' | 'anySourceFile'>;
  constructor(projects: Pick<ProjectRegistry, 'refreshFile' | 'sourceFile' | 'anySourceFile'>) { this.projects = projects; }
  read(file: string): string { return readFileSync(file, 'utf8'); }
  declarationAt(file: string, line: number, offset: number): SyntaxDeclaration | null {
    const source = this.parse(file);
    return declarationAt(this.tokenAt(source, source.getPositionOfLineAndCharacter(line - 1, offset - 1)), source);
  }
  declarationForSpan(file: string, start: { line: number; offset: number }): SyntaxDeclaration | null { return this.declarationAt(file, start.line, start.offset); }
  ownerForSpan(file: string, start: { line: number; offset: number }): SyntaxDeclaration {
    const source = this.parse(file);
    return ownerAt(this.tokenAt(source, source.getPositionOfLineAndCharacter(start.line - 1, start.offset - 1)), source) ?? moduleFor(source);
  }
  module(file: string): SyntaxDeclaration { return moduleFor(this.parse(file)); }
  private parse(file: string): ts.SourceFile {
    this.projects.refreshFile(file);
    const source = this.projects.sourceFile(file) ?? this.projects.anySourceFile(file);
    if (!source) throw new Error(`${file} is not loaded in the TypeScript 7 snapshot.`);
    return source;
  }
  private tokenAt(source: ts.SourceFile, position: number): ts.Node {
    let current: ts.Node = source;
    for (;;) {
      const child = current.forEachChild((candidate) => position >= candidate.getFullStart() && position < candidate.getEnd() ? candidate : undefined);
      if (!child) return current;
      current = child;
    }
  }
}

function declarationAt(node: ts.Node, source: ts.SourceFile): SyntaxDeclaration | null {
  let current: ts.Node | undefined = node;
  while (current) {
    const declaration = declarationFor(current);
    if (declaration) return describe(declaration, source);
    current = current.parent;
  }
  return null;
}

function ownerAt(node: ts.Node, source: ts.SourceFile): SyntaxDeclaration | null {
  let current: ts.Node | undefined = node;
  while (current) {
    const declaration = declarationFor(current);
    if (declaration && namedCallable(declaration)) return describe(declaration, source);
    current = current.parent;
  }
  return null;
}

function declarationFor(node: ts.Node): ts.Declaration | null {
  if (ts.isVariableDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isMethodDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isParameterDeclaration(node) || ts.isImportSpecifier(node) || ts.isExportSpecifier(node)) return node;
  return null;
}

function namedCallable(node: ts.Declaration): boolean {
  if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) return !!node.name && !!node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
  return (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && !!node.name;
}

function describe(node: ts.Declaration, source: ts.SourceFile): SyntaxDeclaration | null {
  const name = (node as ts.Declaration & { name?: ts.Node }).name;
  if (!name || !ts.isIdentifier(name) && !ts.isPrivateIdentifier(name) && !ts.isStringLiteral(name)) return null;
  const parent = node.parent;
  const container = parent && (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent) || ts.isEnumDeclaration(parent)) && parent.name ? parent.name.text : undefined;
  return { name: (name as { text: string }).text, kind: ts.SyntaxKind[node.kind] ?? 'unknown', nameSpan: { start: name.getStart(source), end: name.getEnd() }, span: { start: node.getStart(source), end: node.getEnd() }, containerName: container };
}

function moduleFor(source: ts.SourceFile): SyntaxDeclaration {
  return { name: path.basename(source.fileName), kind: 'module', nameSpan: { start: 0, end: 0 }, span: { start: 0, end: source.getEnd() } };
}
