import path from 'node:path';
import * as ts from '../ts7/ast.js';
import type { DeclarationRecord } from '../core/declarations.js';
import type { SemanticContext } from '../server/context.js';

export interface Site { id: string; file: string; path: string; line: number; col: number; callStart: number; text: string; }
export interface ProtocolSpan { file: string; start: { line: number; offset: number }; end?: { line: number; offset: number }; }
export interface DefinitionTarget extends ProtocolSpan {}
export type TargetClass = 'dispatch' | 'concrete' | 'noncallable' | 'external';

export function callSitesFor(context: SemanticContext, record: DeclarationRecord): Site[] {
  const source = parse(context, record.file);
  const sites: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== source && namedCallable(node) && !isCurrent(node, record, source)) return;
    const token = calleeToken(node);
    if (token && owns(context, node, record, source)) {
      const point = source.getLineAndCharacterOfPosition(token.getStart(source));
      const line = point.line + 1;
      const col = point.character + 1;
      const displayPath = relative(context.root, record.file);
      sites.push({ id: `${displayPath}:${line}:${col}`, file: record.file, path: displayPath, line, col, callStart: source.getLineAndCharacterOfPosition(node.getStart(source)).character + 1, text: token.getText(source) });
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return [...new Map(sites.map((site) => [site.id, site])).values()];
}

export function roleAt(context: SemanticContext, file: string, line: number, col: number, definition: boolean, write: boolean): 'definition' | 'import' | 'type' | 'call' | 'write' | 'read' {
  if (definition) return 'definition';
  const source = parse(context, file);
  const node = tokenAt(source, source.getPositionOfLineAndCharacter(line - 1, col - 1));
  let current: ts.Node | undefined = node;
  while (current) {
    if (ts.isImportSpecifier(current) || ts.isImportClause(current) || ts.isNamespaceImport(current) || ts.isExportSpecifier(current)) return 'import';
    if (ts.isTypeNode(current) || ts.isTypeQueryNode(current) || ts.isExpressionWithTypeArguments(current)) return 'type';
    const token = calleeToken(current);
    if (token && (token === node || token.getStart(source) === node.getStart(source))) return 'call';
    current = current.parent;
  }
  return write ? 'write' : 'read';
}

export function classifyTarget(context: SemanticContext, target: DefinitionTarget): TargetClass {
  const file = target.file;
  const source = parse(context, file);
  let node: ts.Node | undefined = tokenAt(source, source.getPositionOfLineAndCharacter(target.start.line - 1, target.start.offset - 1));
  while (node) {
    if (ts.isMethodSignatureDeclaration(node)) return 'dispatch';
    if ((ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node)) && hasModifier(node, ts.SyntaxKind.AbstractKeyword)) return 'dispatch';
    if (hasModifier(node, ts.SyntaxKind.DeclareKeyword)) return 'dispatch';
    if (namedCallable(node)) {
      for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
        if (hasModifier(parent, ts.SyntaxKind.DeclareKeyword) || ts.isSourceFile(parent) && parent.isDeclarationFile) return 'dispatch';
      }
      return external(file) ? 'external' : 'concrete';
    }
    if (ts.isParameterDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isVariableDeclaration(node)) return 'noncallable';
    node = node.parent;
  }
  return 'noncallable';
}

export function external(file: string): boolean { return file.includes('/node_modules/') || /\/lib\.[^.]+\.d\.ts$/.test(file) || path.basename(file).startsWith('lib.') && file.endsWith('.d.ts'); }
export function targetAddress(context: SemanticContext, target: ProtocolSpan): string { return `${relative(context.root, target.file)}:${target.start.line}:${target.start.offset}`; }
export function relative(root: string, file: string): string { return path.relative(root, file).split(path.sep).join('/'); }

function parse(context: SemanticContext, file: string): ts.SourceFile {
  context.projects.refreshFile(file);
  const source = context.projects.sourceFile(file) ?? context.projects.anySourceFile(file);
  if (!source) throw new Error(`${file} is not loaded in the TypeScript 7 snapshot.`);
  return source;
}
function tokenAt(source: ts.SourceFile, position: number): ts.Node { let current: ts.Node = source; for (;;) { const child = current.forEachChild((candidate) => position >= candidate.getFullStart() && position < candidate.getEnd() ? candidate : undefined); if (!child) return current; current = child; } }
function namedCallable(node: ts.Node): boolean { return (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isVariableDeclaration(node) && !!node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) && !!('name' in node && node.name); }
function owns(context: SemanticContext, node: ts.Node, record: DeclarationRecord, source: ts.SourceFile): boolean {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source));
  const owner = context.source.ownerForSpan(record.file, { line: start.line + 1, offset: start.character + 1 });
  return owner.kind === 'module' ? record.kind === 'module' : owner.nameSpan.start === record.nameSpan.start && owner.nameSpan.end === record.nameSpan.end;
}
function isCurrent(node: ts.Node, record: DeclarationRecord, source: ts.SourceFile): boolean {
  const name = (node as ts.Declaration & { name?: ts.Node }).name;
  return !!name && name.getStart(source) === record.nameSpan.start && name.getEnd() === record.nameSpan.end;
}
function calleeToken(node: ts.Node): ts.Node | null {
  let expression: ts.Expression | ts.JsxTagNameExpression | undefined;
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) expression = node.expression;
  else if (ts.isTaggedTemplateExpression(node)) expression = node.tag;
  else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) expression = node.tagName;
  else return null;
  if (ts.isPropertyAccessExpression(expression)) return expression.name;
  return expression;
}
function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean { return !!(node as ts.Node & { modifiers?: readonly { kind: ts.SyntaxKind }[] }).modifiers?.some((modifier) => modifier.kind === kind); }
