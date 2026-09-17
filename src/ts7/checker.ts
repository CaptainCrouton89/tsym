import path from 'node:path';
import { DiagnosticCategory, SymbolFlags, type Diagnostic, type Project, type Snapshot, type Symbol as TsSymbol, type Type } from 'typescript/unstable/sync';
import { SyntaxKind, isFunctionLikeDeclaration, isTypeNode, type Node, type TypeNode } from 'typescript/unstable/ast';
import * as ts from './ast.js';
import { Ts7Host } from './api.js';
import { ConfiguredProjects } from './projects.js';

export interface TypeAnswer {
  kind: string;
  modifiers: string | undefined;
  signature: string;
  documentation: string;
  tags: readonly { name: string; text: string }[];
  definitions: readonly string[];
}

export interface CheckerDiagnostic {
  file: string;
  line: number;
  column: number;
  severity: string;
  code: number;
  message: string;
}

export interface RenameOccurrence { file: string; line: number; col: number; }
export interface CheckerRenameEdit extends RenameOccurrence { startUtf16: number; endUtf16: number; oldText: string; replacement: string; }

export class RenamePreflightError extends Error {
  constructor(readonly code: 'rename-through-string-literal' | 'rename-through-computed-name' | 'rename-outside-workspace' | 'rename-conflict', readonly site: string, message: string) { super(message); }
}

export function typeAt(host: Ts7Host, root: string, config: string, file: string, position: number, fallback: { kind: string; name: string; address: string }): TypeAnswer | null {
  return host.withSnapshot((snapshot) => {
    const project = snapshot.getProject(config);
    if (!project) throw new Error(`TypeScript project ${config} is not loaded.`);
    const symbol = project.checker.getSymbolAtPosition(file, position);
    const type = project.checker.getTypeAtPosition(file, position);
    if (!symbol || !type) return null;
    const declaration = symbol.declarations.find((handle) => handle.path === file)?.resolve(project) ?? symbol.declarations[0]?.resolve(project);
    const signature = renderSignature(project, declaration, type, symbol.name, fallback.kind);
    const definitions = typeDefinitions(project, root, declaration, fallback.address);
    return {
      kind: fallback.kind,
      modifiers: declaration ? modifiers(declaration) : undefined,
      signature,
      documentation: project.checker.getDocumentationCommentOfSymbol(symbol),
      tags: project.checker.getJsDocTagsOfSymbol(symbol).map((tag) => ({ name: tag.name, text: tag.text ?? '' })),
      definitions,
    };
  });
}

export function diagnosticsForFiles(host: Ts7Host, root: string, scopes: readonly { config: string; files: readonly string[] }[]): CheckerDiagnostic[] {
  return host.withSnapshot((snapshot) => {
    const diagnostics: CheckerDiagnostic[] = [];
    for (const scope of scopes) {
      const project = snapshot.getProject(scope.config);
      if (!project) throw new Error(`TypeScript project ${scope.config} is not loaded.`);
      for (const file of scope.files) diagnostics.push(...normalizeDiagnostics(root, project, [
        ...project.program.getSyntacticDiagnostics(file),
        ...project.program.getSemanticDiagnostics(file),
        ...project.program.getSuggestionDiagnostics(file),
      ]));
    }
    return unique(diagnostics);
  });
}

/** Builds rename edits from indexed reference sites and rejects shapes TS7 cannot rewrite safely. */
export function renameFromOccurrences(host: Ts7Host, root: string, projects: ConfiguredProjects, declaration: { file: string; nameSpan: { start: number }; address: string; name: string }, occurrences: readonly RenameOccurrence[], newName: string): CheckerRenameEdit[] {
  return host.withSnapshot((snapshot) => {
    const declarationProject = projects.membership(declaration.file);
    if (!declarationProject) throw new Error(`The declaration ${declaration.address} is not in a configured TypeScript project.`);
    const project = snapshot.getProject(declarationProject.config);
    if (!project) throw new Error(`TypeScript project ${declarationProject.config} is not loaded.`);
    const renamed = symbolAt(project, declaration.file, declaration.nameSpan.start);
    if (!renamed) throw new Error(`TypeScript could not resolve ${declaration.address}.`);
    const target = unalias(project, renamed);
    assertWorkspaceDeclarations(root, project, target, declaration.address);
    assertNoStringLiteralRename(root, projects, snapshot, target, declaration.name);
    const declarationSource = project.program.getSourceFile(declaration.file);
    if (!declarationSource) throw new Error(`TypeScript could not load ${declaration.file} for rename.`);
    const declarationPoint = declarationSource.getLineAndCharacterOfPosition(declaration.nameSpan.start);
    const declarationOccurrence = { file: relative(root, declaration.file), line: declarationPoint.line + 1, col: declarationPoint.character + 1 };

    const edits = new Map<string, CheckerRenameEdit>();
    const sites = new Map<string, RenameOccurrence>();
    for (const occurrence of [...occurrences, declarationOccurrence, ...shapeOccurrences(root, projects, snapshot, target)]) sites.set(address(occurrence), occurrence);
    for (const occurrence of sites.values()) {
      const file = path.resolve(root, occurrence.file);
      const membership = projects.membership(file);
      if (!membership) throw new Error(`The indexed rename site ${address(occurrence)} is not in a configured TypeScript project.`);
      const siteProject = snapshot.getProject(membership.config);
      if (!siteProject) throw new Error(`TypeScript project ${membership.config} is not loaded.`);
      const source = siteProject.program.getSourceFile(file);
      if (!source) throw new Error(`TypeScript could not load ${occurrence.file} for rename.`);
      const position = source.getPositionOfLineAndCharacter(occurrence.line - 1, occurrence.col - 1);
      const node = nodeAt(source, position);
      if (!node || !ts.isIdentifier(node)) throw new Error(`The indexed rename site ${address(occurrence)} is not an identifier in the current program.`);
      if (hasComputedName(node)) throw new RenamePreflightError('rename-through-computed-name', address(occurrence), `Cannot rename through computed property name at ${address(occurrence)}.`);
      if (isExplicitImportAliasLocal(siteProject, file, node)) continue;
      if (!renameSymbols(siteProject, file, node).some((candidate) => sameSymbol(siteProject, candidate, target))) throw new Error(`The indexed rename site ${address(occurrence)} no longer resolves to ${declaration.address}.`);
      if (isExportAlias(node)) continue;
      assertNoConflict(siteProject, target, newName, node, address(occurrence));
      const edit = editForNode(siteProject, source, node, target, newName);
      edits.set(`${occurrence.file}:${edit.startUtf16}:${edit.endUtf16}`, { ...occurrence, ...edit });
    }

    return [...edits.values()].sort((left, right) => left.file.localeCompare(right.file) || left.startUtf16 - right.startUtf16 || left.endUtf16 - right.endUtf16);
  });
}

function assertWorkspaceDeclarations(root: string, project: Project, symbol: TsSymbol, site: string): void {
  for (const handle of symbol.declarations) {
    const declaration = handle.resolve(project);
    if (declaration && !inside(root, declaration.getSourceFile().fileName)) throw new RenamePreflightError('rename-outside-workspace', site, `Cannot rename ${symbol.name}: a declaration is outside the workspace at ${declaration.getSourceFile().fileName}.`);
  }
}

function assertNoStringLiteralRename(root: string, projects: ConfiguredProjects, snapshot: Snapshot, target: TsSymbol, name: string): void {
  for (const scope of projects.records()) {
    const project = snapshot.getProject(scope.config);
    if (!project) continue;
    for (const file of scope.files) {
      const source = project.program.getSourceFile(file);
      if (!source) continue;
      const string = firstStringElementAccess(source, (node) => node.text === name, (argument) => {
        const symbol = symbolAt(project, file, argument.getStart(source));
        return !!symbol && sameSymbol(project, symbol, target);
      });
      if (string) {
        const point = source.getLineAndCharacterOfPosition(string.getStart(source));
        throw new RenamePreflightError('rename-through-string-literal', `${relative(root, file)}:${point.line + 1}:${point.character + 1}`, `Cannot rename through string-literal element access at ${relative(root, file)}:${point.line + 1}:${point.character + 1}.`);
      }
    }
  }
}

function shapeOccurrences(root: string, projects: ConfiguredProjects, snapshot: Snapshot, target: TsSymbol): RenameOccurrence[] {
  const sites = new Map<string, RenameOccurrence>();
  const add = (file: string, source: ts.SourceFile, node: Node) => {
    if (!ts.isIdentifier(node)) return;
    const point = source.getLineAndCharacterOfPosition(node.getStart(source));
    const site = { file: relative(root, file), line: point.line + 1, col: point.character + 1 };
    sites.set(address(site), site);
  };
  const visit = (project: Project, file: string, source: ts.SourceFile, node: Node): void => {
    if (ts.isShorthandPropertyAssignment(node) && ts.isIdentifier(node.name)) {
      const value = project.checker.getShorthandAssignmentValueSymbol(node);
      if (value && sameSymbol(project, value, target)) add(file, source, node.name);
    }
    if (ts.isExportSpecifier(node)) {
      const value = project.checker.getExportSpecifierLocalTargetSymbol(node);
      if (value && sameSymbol(project, value, target)) add(file, source, node.propertyName ?? node.name);
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals && ts.isIdentifier(node.expression)) {
      const value = symbolAt(project, file, node.expression.getStart(source));
      if (value && sameSymbol(project, value, target)) add(file, source, node.expression);
    }
    if (ts.isObjectLiteralElementLike(node)) {
      const name = 'name' in node ? node.name : undefined;
      if (name && ts.isIdentifier(name)) {
        const property = contextualObjectProperty(project, name);
        if (property && sameSymbol(project, property, target)) add(file, source, name);
      }
    }
    if (ts.isBindingElement(node)) {
      const bindingName = node.name;
      if (bindingName && ts.isIdentifier(bindingName)) {
        const property = destructuredProperty(project, bindingName);
        if (property && sameSymbol(project, property, target)) add(file, source, bindingName);
      }
    }
    node.forEachChild((child) => visit(project, file, source, child));
  };
  for (const scope of projects.records()) {
    const project = snapshot.getProject(scope.config);
    if (!project) continue;
    for (const file of scope.files) {
      if (projects.membership(file)?.config !== scope.config) continue;
      const source = project.program.getSourceFile(file);
      if (source) visit(project, file, source, source);
    }
  }
  return [...sites.values()];
}

function firstStringElementAccess(node: Node, namesSymbol: (node: ts.StringLiteral) => boolean, matches: (argument: Node) => boolean): ts.StringLiteral | undefined {
  if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression) && namesSymbol(node.argumentExpression) && matches(node.argumentExpression)) return node.argumentExpression;
  let found: ts.StringLiteral | undefined;
  node.forEachChild((child) => { if (!found) found = firstStringElementAccess(child, namesSymbol, matches); });
  return found;
}

function assertNoConflict(project: Project, target: TsSymbol, name: string, location: Node, site: string): void {
  const resolved = project.checker.resolveName(name, target.flags, location);
  if (resolved && !sameSymbol(project, resolved, target)) throw conflict(project, name, site, resolved);
  const member = memberNamed(project, location, name);
  if (member && !sameSymbol(project, member, target)) throw conflict(project, name, site, member);
}

function memberNamed(project: Project, location: Node, name: string): TsSymbol | undefined {
  if (ts.isPropertyAccessExpression(location.parent) && location.parent.name === location) {
    const type = project.checker.getTypeAtLocation(location.parent.expression);
    return type && project.checker.getPropertyOfType(type, name);
  }
  for (let current: Node | undefined = location.parent; current; current = current.parent) {
    if (ts.isClassLikeDeclaration(current) || ts.isInterfaceDeclaration(current)) {
      const type = project.checker.getTypeAtLocation(current);
      return type && project.checker.getPropertyOfType(type, name);
    }
  }
  return undefined;
}

function conflict(project: Project, name: string, site: string, resolved: TsSymbol): RenamePreflightError {
  return new RenamePreflightError('rename-conflict', site, `Cannot rename to ${name}: it resolves to ${unalias(project, resolved).name} at ${site}.`);
}

function renameSymbols(project: Project, file: string, node: ts.Identifier): TsSymbol[] {
  const symbols = [
    ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node ? project.checker.getShorthandAssignmentValueSymbol(node.parent) : undefined,
    ts.isExportSpecifier(node.parent) ? project.checker.getExportSpecifierLocalTargetSymbol(node.parent) : undefined,
    contextualObjectProperty(project, node),
    destructuredProperty(project, node),
    symbolAt(project, file, node.getStart(node.getSourceFile())),
  ];
  return symbols.filter((symbol): symbol is TsSymbol => !!symbol);
}

function contextualObjectProperty(project: Project, node: ts.Identifier): TsSymbol | undefined {
  const member = node.parent;
  if (!member || !ts.isObjectLiteralElementLike(member) || !('name' in member) || member.name !== node) return undefined;
  const object = member.parent;
  const contextual = object && ts.isObjectLiteralExpression(object) ? project.checker.getContextualType(object) : undefined;
  return contextual && project.checker.getPropertyOfType(contextual, node.text);
}

function destructuredProperty(project: Project, node: ts.Identifier): TsSymbol | undefined {
  const element = node.parent;
  if (!element || !ts.isBindingElement(element) || element.name !== node || element.propertyName) return undefined;
  const pattern = element.parent;
  const declaration = pattern?.parent;
  if (!pattern || !ts.isObjectBindingPattern(pattern) || !declaration || !ts.isVariableDeclaration(declaration) || !declaration.initializer) return undefined;
  const type = project.checker.getTypeAtLocation(declaration.initializer);
  return type && project.checker.getPropertyOfType(type, node.text);
}

function isExportAlias(node: ts.Identifier): boolean { return ts.isExportSpecifier(node.parent) && node.parent.propertyName !== undefined && node.parent.name === node; }

function isExplicitImportAliasLocal(project: Project, file: string, node: ts.Identifier): boolean {
  const symbol = symbolAt(project, file, node.getStart(node.getSourceFile()));
  if (!symbol || !(symbol.flags & SymbolFlags.Alias)) return false;
  return symbol.declarations.some((handle) => {
    const declaration = handle.resolve(project);
    return !!declaration && ts.isImportSpecifier(declaration) && declaration.propertyName !== undefined;
  });
}

function editForNode(project: Project, source: ts.SourceFile, node: ts.Identifier, target: TsSymbol, newName: string): Pick<CheckerRenameEdit, 'startUtf16' | 'endUtf16' | 'oldText' | 'replacement'> {
  const parent = node.parent;
  const oldText = node.getText(source);
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) {
    const value = project.checker.getShorthandAssignmentValueSymbol(parent);
    if (value) return { startUtf16: node.getStart(source), endUtf16: node.getEnd(), oldText, replacement: sameSymbol(project, value, target) ? `${oldText}: ${newName}` : `${newName}: ${oldText}` };
  }
  if (ts.isBindingElement(parent) && parent.name === node && !parent.propertyName && ts.isObjectBindingPattern(parent.parent)) {
    const binding = symbolAt(project, source.fileName, node.getStart(source));
    return { startUtf16: node.getStart(source), endUtf16: node.getEnd(), oldText, replacement: binding && sameSymbol(project, binding, target) ? `${oldText}: ${newName}` : `${newName}: ${oldText}` };
  }
  if (ts.isExportSpecifier(parent)) {
    const local = project.checker.getExportSpecifierLocalTargetSymbol(parent);
    if (local && sameSymbol(project, local, symbolAt(project, source.fileName, node.getStart(source))!)) {
      if (parent.name === node && !parent.propertyName) return { startUtf16: node.getStart(source), endUtf16: node.getEnd(), oldText, replacement: `${newName} as ${oldText}` };
    }
  }
  return { startUtf16: node.getStart(source), endUtf16: node.getEnd(), oldText, replacement: newName };
}

function hasComputedName(node: Node): boolean {
  for (let current: Node | undefined = node; current; current = current.parent) if (ts.isComputedPropertyName(current)) return true;
  return false;
}

function nodeAt(node: Node, position: number): Node | undefined {
  let found: Node | undefined;
  node.forEachChild((child) => { if (position >= child.getFullStart() && position < child.getEnd()) found = nodeAt(child, position) ?? found; });
  return found ?? (node.getStart(node.getSourceFile()) === position ? node : undefined);
}

function symbolAt(project: Project, file: string, position: number): TsSymbol | undefined { return project.checker.getSymbolAtPosition(file, position); }
function unalias(project: Project, symbol: TsSymbol): TsSymbol { return symbol.flags & SymbolFlags.Alias ? project.checker.getAliasedSymbol(symbol) : symbol; }
function sameSymbol(project: Project, left: TsSymbol, right: TsSymbol): boolean {
  const resolvedLeft = unalias(project, left);
  const resolvedRight = unalias(project, right);
  return resolvedLeft.id !== 0 && resolvedLeft.id === resolvedRight.id || resolvedLeft.declarations.some((leftDeclaration) => resolvedRight.declarations.some((rightDeclaration) => leftDeclaration.path === rightDeclaration.path && leftDeclaration.index === rightDeclaration.index));
}
function address(site: RenameOccurrence): string { return `${site.file}:${site.line}:${site.col}`; }

function renderSignature(project: Project, declaration: Node | undefined, type: Type, name: string, kind: string): string {
  if (declaration && isFunctionLikeDeclaration(declaration)) {
    const signature = project.checker.getSignatureFromDeclaration(declaration);
    if (signature) {
      const generated = project.checker.signatureToSignatureDeclaration(signature, SyntaxKind.FunctionDeclaration);
      if (generated) {
        const text = project.emitter.printNode(generated).replace(/;$/, '');
        if (text.startsWith('function ')) return `function ${name}${text.slice('function'.length).trimStart()}`;
      }
    }
  }
  const value = project.checker.typeToString(type, declaration);
  if (kind === 'interface' || kind === 'class' || kind === 'type' || kind === 'enum') return `${kind} ${name}`;
  return value;
}

function typeDefinitions(project: Project, root: string, declaration: Node | undefined, fallback: string): string[] {
  if (!declaration) return [fallback];
  const nodes = annotationNodes(declaration);
  const definitions = nodes.flatMap((node) => {
    const type = project.checker.getTypeFromTypeNode(node);
    return type ? declarationAddresses(project, root, type.getSymbol()?.declarations ?? []) : [];
  });
  return definitions.length > 0 ? uniqueStrings(definitions) : [fallback];
}

function annotationNodes(declaration: Node): TypeNode[] {
  const typed = declaration as Node & { type?: Node; parameters?: readonly (Node & { type?: Node })[] };
  return [...(typed.parameters ?? []).flatMap((parameter: Node & { type?: Node }) => parameter.type && isTypeNode(parameter.type) ? [parameter.type] : []), ...(typed.type && isTypeNode(typed.type) ? [typed.type] : [])];
}

function declarationAddresses(project: Project, root: string, declarations: readonly { resolve(project?: Project): Node | undefined }[]): string[] {
  return declarations.flatMap((handle) => {
    const declaration = handle.resolve(project);
    if (!declaration) return [];
    const source = declaration.getSourceFile();
    if (!inside(root, source.fileName)) return [];
    const name = (declaration as Node & { name?: Node }).name ?? declaration;
    const location = source.getLineAndCharacterOfPosition(name.getStart(source));
    return [`${relative(root, source.fileName)}:${location.line + 1}:${location.character + 1}`];
  });
}

function modifiers(declaration: Node): string | undefined {
  const values = (declaration as Node & { modifiers?: readonly Node[] }).modifiers?.map((modifier: Node) => modifier.getText(declaration.getSourceFile())).filter((modifier) => modifier !== 'async').join(' ');
  return values || undefined;
}

function normalizeDiagnostics(root: string, project: Project, diagnostics: readonly Diagnostic[]): CheckerDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    if (!diagnostic.fileName || !inside(root, diagnostic.fileName)) return [];
    const source = project.program.getSourceFile(diagnostic.fileName);
    if (!source) return [];
    const location = source.getLineAndCharacterOfPosition(Math.max(0, diagnostic.pos));
    return [{
      file: relative(root, diagnostic.fileName),
      line: location.line + 1,
      column: location.character + 1,
      severity: severity(diagnostic.category),
      code: diagnostic.code,
      message: diagnostic.text,
    }];
  });
}

function severity(category: DiagnosticCategory): string {
  if (category === DiagnosticCategory.Warning) return 'warning';
  if (category === DiagnosticCategory.Error) return 'error';
  if (category === DiagnosticCategory.Suggestion) return 'suggestion';
  return 'message';
}

function unique(values: readonly CheckerDiagnostic[]): CheckerDiagnostic[] {
  return [...new Map(values.map((diagnostic) => [`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code}:${diagnostic.severity}:${diagnostic.message}`, diagnostic])).values()];
}

function uniqueStrings(values: readonly string[]): string[] { return [...new Set(values)]; }
function inside(root: string, file: string): boolean { const value = path.relative(root, file); return value === '' || !value.startsWith(`..${path.sep}`) && value !== '..' && !path.isAbsolute(value); }
function relative(root: string, file: string): string { return path.relative(root, file).split(path.sep).join('/'); }
