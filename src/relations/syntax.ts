import { createRequire } from 'node:module';
import path from 'node:path';
import type * as ts from 'typescript';
import type { DeclarationRecord } from '../core/declarations.js';
import type { SemanticContext } from '../server/context.js';

export interface Site { id: string; file: string; path: string; line: number; col: number; callStart: number; text: string; }
export interface ProtocolSpan { file: string; start: { line: number; offset: number }; end?: { line: number; offset: number }; }
export interface DefinitionTarget extends ProtocolSpan {}
export type TargetClass = 'dispatch' | 'concrete' | 'noncallable' | 'external';

export function callSitesFor(context: SemanticContext, record: DeclarationRecord): Site[] {
  const compiler = loadCompiler(context);
  const source = parse(context, record.file, compiler);
  const sites: Site[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== source && namedCallable(node, compiler) && !isCurrent(node, record, source)) return;
    const token = calleeToken(node, compiler);
    if (token && owns(node, record, source, compiler)) {
      const point = compiler.getLineAndCharacterOfPosition(source, token.getStart(source));
      const line = point.line + 1;
      const col = point.character + 1;
      const displayPath = relative(context.root, record.file);
      sites.push({ id: `${displayPath}:${line}:${col}`, file: record.file, path: displayPath, line, col, callStart: compiler.getLineAndCharacterOfPosition(source, node.getStart(source)).character + 1, text: token.getText(source) });
    }
    node.forEachChild(visit);
  };
  source.forEachChild(visit);
  return [...new Map(sites.map((site) => [site.id, site])).values()];
}

export function roleAt(context: SemanticContext, file: string, line: number, col: number, definition: boolean, write: boolean): 'definition' | 'import' | 'type' | 'call' | 'write' | 'read' {
  if (definition) return 'definition';
  const compiler = loadCompiler(context);
  const source = parse(context, file, compiler);
  const node = tokenAt(source, source.getPositionOfLineAndCharacter(line - 1, col - 1));
  let current: ts.Node | undefined = node;
  while (current) {
    if (compiler.isImportSpecifier(current) || compiler.isImportClause(current) || compiler.isNamespaceImport(current) || compiler.isExportSpecifier(current)) return 'import';
    if (compiler.isTypeNode(current) || compiler.isTypeQueryNode(current) || compiler.isExpressionWithTypeArguments(current)) return 'type';
    const token = calleeToken(current, compiler);
    if (token && (token === node || token.getStart(source) === node.getStart(source))) return 'call';
    current = current.parent;
  }
  return write ? 'write' : 'read';
}

export function classifyTarget(context: SemanticContext, target: DefinitionTarget): TargetClass {
  const file = target.file;
  if (external(file)) return 'external';
  const compiler = loadCompiler(context);
  const source = parse(context, file, compiler);
  let node: ts.Node | undefined = tokenAt(source, source.getPositionOfLineAndCharacter(target.start.line - 1, target.start.offset - 1));
  while (node) {
    if (compiler.isMethodSignature(node) || compiler.isCallSignatureDeclaration(node) || compiler.isConstructSignatureDeclaration(node)) return 'dispatch';
    if ((compiler.isMethodDeclaration(node) || compiler.isFunctionDeclaration(node)) && hasModifier(node, compiler.SyntaxKind.AbstractKeyword, compiler)) return 'dispatch';
    if (hasModifier(node, compiler.SyntaxKind.DeclareKeyword, compiler)) return 'dispatch';
    if (namedCallable(node, compiler)) return 'concrete';
    if (compiler.isParameter(node) || compiler.isPropertyDeclaration(node) || compiler.isVariableDeclaration(node)) return 'noncallable';
    node = node.parent;
  }
  return 'noncallable';
}

export function external(file: string): boolean { return file.includes('/node_modules/') || /\/lib\.[^.]+\.d\.ts$/.test(file) || path.basename(file).startsWith('lib.') && file.endsWith('.d.ts'); }
export function targetAddress(context: SemanticContext, target: ProtocolSpan): string { return `${relative(context.root, target.file)}:${target.start.line}:${target.start.offset}`; }
export function relative(root: string, file: string): string { return path.relative(root, file).split(path.sep).join('/'); }

function loadCompiler(context: SemanticContext): typeof ts { return createRequire(import.meta.url)(context.session.location.path.replace(/tsserver\.js$/, 'typescript.js')) as typeof ts; }
function parse(context: SemanticContext, file: string, compiler: typeof ts): ts.SourceFile { return compiler.createSourceFile(file, context.source.read(file), compiler.ScriptTarget.Latest, true, file.endsWith('.tsx') ? compiler.ScriptKind.TSX : compiler.ScriptKind.TS); }
function tokenAt(source: ts.SourceFile, position: number): ts.Node { let current: ts.Node = source; for (;;) { const child = current.forEachChild((candidate) => position >= candidate.getFullStart() && position < candidate.getEnd() ? candidate : undefined); if (!child) return current; current = child; } }
function namedCallable(node: ts.Node, compiler: typeof ts): boolean { return (compiler.isFunctionDeclaration(node) || compiler.isMethodDeclaration(node) || compiler.isGetAccessorDeclaration(node) || compiler.isSetAccessorDeclaration(node) || compiler.isConstructorDeclaration(node) || compiler.isVariableDeclaration(node) && !!node.initializer && (compiler.isArrowFunction(node.initializer) || compiler.isFunctionExpression(node.initializer))) && !!('name' in node && node.name); }
function owns(node: ts.Node, record: DeclarationRecord, source: ts.SourceFile, compiler: typeof ts): boolean {
  let current: ts.Node | undefined = node;
  while (current && current !== source) {
    if (namedCallable(current, compiler)) return isCurrent(current, record, source);
    current = current.parent;
  }
  return record.kind === 'module';
}
function isCurrent(node: ts.Node, record: DeclarationRecord, source: ts.SourceFile): boolean {
  const name = (node as ts.NamedDeclaration).name;
  return !!name && name.getStart(source) === record.nameSpan.start && name.getEnd() === record.nameSpan.end;
}
function calleeToken(node: ts.Node, compiler: typeof ts): ts.Node | null {
  let expression: ts.Expression | ts.JsxTagNameExpression | undefined;
  if (compiler.isCallExpression(node) || compiler.isNewExpression(node)) expression = node.expression;
  else if (compiler.isTaggedTemplateExpression(node)) expression = node.tag;
  else if (compiler.isJsxOpeningElement(node) || compiler.isJsxSelfClosingElement(node)) expression = node.tagName;
  else return null;
  if (compiler.isPropertyAccessExpression(expression)) return expression.name;
  return expression;
}
function hasModifier(node: ts.Node, kind: ts.SyntaxKind, compiler: typeof ts): boolean { return !!compiler.getModifiers(node as ts.HasModifiers)?.some((modifier) => modifier.kind === kind); }
