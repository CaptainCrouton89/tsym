import path from 'node:path';
import { SymbolFlags, type Checker, type Project, type Symbol as TsSymbol } from 'typescript/unstable/sync';
import * as ts from '../ts7/ast.js';
import { Ts7Host } from '../ts7/api.js';
import { ConfiguredProjects, type ConfiguredProject } from '../ts7/projects.js';
import { declarationTarget, moduleTarget, relative, type DeclarationLookup, type Target } from './classify.js';
import { describeFile, type KeyedDeclaration } from './descriptor.js';
import { isIndexedDeclaration } from './scope.js';
import type { DeclarationKind, DeclarationNode, ExternalNode, FileGraph, IndexGraph, IndexRelationship, ReferenceRole, TypePosition } from './graph.js';

interface FileState {
  absolute: string;
  file: string;
  source: ts.SourceFile;
  project: Project;
  checker: Checker;
  descriptors: readonly KeyedDeclaration[];
  indexed: readonly KeyedDeclaration[];
  byStart: ReadonlyMap<number, KeyedDeclaration>;
  nodesByStart: ReadonlyMap<number, ts.Node>;
}

export function walkIndex(root: string, program: Ts7Host, projects: ConfiguredProjects): IndexGraph {
  const states = statesFor(root, program, projects.records());
  const lookup: DeclarationLookup = {
    root,
    indexedByStart: new Map(states.map((state) => [state.file, state.byStart])),
  };
  const declarations = new Map<string, DeclarationNode>();
  const externals = new Map<string, ExternalNode>();
  const fileRelationships = new Map<string, IndexRelationship[]>();
  let internalSites = 0;
  let unresolvedOccurrences = 0;

  const addExternal = (node: ExternalNode): void => { externals.set(node.key, node); };
  const addTarget = (target: Target, unresolved: boolean): string | null => {
    if (target === null) { internalSites++; return null; }
    if (unresolved) { unresolvedOccurrences++; return null; }
    if (target.external) addExternal(target.node);
    return target.key;
  };

  for (const state of states) {
    const relationships: IndexRelationship[] = [];
    fileRelationships.set(state.file, relationships);
    for (const descriptor of state.indexed) {
      const existing = declarations.get(descriptor.key);
      if (existing) { existing.declCount++; continue; }
      const declaration = declarationNode(state, descriptor);
      declarations.set(declaration.key, declaration);
    }
  }

  const symbolTargets = declarationSymbolTargets(states);
  const resolvedTargets = new Map<number, Target>();

  for (const state of states) {
    const relationships = fileRelationships.get(state.file)!;
    const added = new Set<string>();
    const add = (relationship: IndexRelationship): void => {
      const site = `${relationship.type}:${relationship.from}:${relationship.to}:${'line' in relationship ? relationship.line : ''}:${'col' in relationship ? relationship.col : ''}:${'name' in relationship ? relationship.name : ''}`;
      if (!added.has(site)) { added.add(site); relationships.push(relationship); }
    };
    for (const descriptor of state.indexed) {
      const declaration = declarations.get(descriptor.key)!;
      if (declaration.container) add({ type: 'CONTAINS', from: declaration.container, to: declaration.key });
    }

    const semanticNodes: ts.Node[] = [];
    const collectSemanticNodes = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) semanticNodes.push(node);
      if (ts.isImportDeclaration(node)) semanticNodes.push(node.moduleSpecifier);
      node.forEachChild(collectSemanticNodes);
    };
    state.source.forEachChild(collectSemanticNodes);
    const positions = semanticNodes.map((node) => node.getStart(state.source));
    const symbols = state.checker.getSymbolAtPosition(state.absolute, positions);
    const symbolsByPosition = new Map(positions.map((position, index) => [position, symbols[index]]));
    const symbolFor = (node: ts.Node): TsSymbol | undefined => symbolsByPosition.get(node.getStart(state.source));
    const seenReferences = new Set<number>();
    const callTargets = new Map<number, string | null>();
    const seenTypes = new Set<number>();
    const seenUnresolved = new Set<number>();
    const aliases = new Map<number, TsSymbol>();
    const alias = (symbol: TsSymbol): TsSymbol => {
      const cached = aliases.get(symbol.id);
      if (cached) return cached;
      const resolved = symbol.flags & SymbolFlags.Alias ? state.checker.getAliasedSymbol(symbol) : symbol;
      aliases.set(symbol.id, resolved);
      return resolved;
    };
    const targetFor = (symbol: TsSymbol | undefined, position: number): string | null => {
      if (!symbol || state.checker.isUnknownSymbol(symbol)) {
        if (!seenUnresolved.has(position)) { seenUnresolved.add(position); unresolvedOccurrences++; }
        return null;
      }
      const resolved = alias(symbol);
      if (symbolTargets.has(resolved.id)) {
        const key = symbolTargets.get(resolved.id)!;
        if (key === null) { internalSites++; return null; }
        return key;
      }
      const target = resolvedTargets.has(resolved.id) ? resolvedTargets.get(resolved.id)! : declarationTarget(resolved, lookup, (candidate) => candidate);
      resolvedTargets.set(resolved.id, target);
      return addTarget(target, false);
    };
    const ownerFor = (node: ts.Node): string => ownerForNode(state, node).key;
    const point = (node: ts.Node): { line: number; col: number } => {
      const value = state.source.getLineAndCharacterOfPosition(node.getStart(state.source));
      return { line: value.line + 1, col: value.character + 1 };
    };
    const reference = (node: ts.Identifier, role: ReferenceRole, target?: string | null): void => {
      const start = node.getStart(state.source);
      if (seenReferences.has(start)) return;
      seenReferences.add(start);
      const resolved = target === undefined ? targetFor(state.checker.getSymbolAtLocation(node), start) : target;
      if (!resolved) return;
      const site = point(node);
      add({ type: 'REFERENCES', from: ownerFor(node), to: resolved, ...site, role });
    };
    const call = (node: ts.Node, callee: ts.Node): void => {
      const start = callee.getStart(state.source);
      const target = targetFor(symbolFor(callee), start);
      callTargets.set(start, target);
      reference(callee as ts.Identifier, 'call', target);
      if (!target) return;
      const site = point(callee);
      add({ type: 'CALLS', from: ownerFor(callee), to: target, ...site, dispatch: false });
    };
    const typeMention = (node: ts.TypeNode): void => {
      const start = node.getStart(state.source);
      if (seenTypes.has(start)) return;
      seenTypes.add(start);
      const identifier = firstIdentifier(node);
      if (!identifier) return;
      const target = targetFor(symbolFor(identifier), start);
      if (!target) return;
      const site = point(node);
      add({ type: 'TYPE_MENTION', from: ownerFor(node), to: target, ...site, position: typePosition(node) });
    };

    const visit = (node: ts.Node): void => {
      const callee = callCallee(node);
      if (callee) call(node, callee);
      if (ts.isIdentifier(node)) {
        const start = node.getStart(state.source);
        reference(node, referenceRole(node, callee !== null), callTargets.has(start) ? callTargets.get(start) : targetFor(symbolFor(node), start));
      }
      if (isTypeNode(node)) typeMention(node);
      if (ts.isImportDeclaration(node)) {
        const moduleSpecifier = node.moduleSpecifier;
        const moduleText = ts.isStringLiteral(moduleSpecifier) ? moduleSpecifier.text : moduleSpecifier.getText(state.source);
        const target = moduleTarget(symbolFor(moduleSpecifier), lookup, alias, moduleText);
        const key = addTarget(target, false);
        if (key) {
          const site = point(moduleSpecifier);
          add({ type: 'IMPORTS', from: `${state.file}#<module>`, to: key, line: site.line, names: importNames(node, state.source) });
        }
      }
      if (ts.isExportDeclaration(node)) exportDeclaration(node, state, lookup, addTarget, add, alias);
      node.forEachChild(visit);
    };
    state.source.forEachChild(visit);
    directExports(state, add);
  }

  const files = new Map<string, FileGraph>();
  for (const state of states) {
    const ids = [...new Set(state.indexed.map((descriptor) => descriptor.key))];
    files.set(state.file, { declarations: ids, relationships: fileRelationships.get(state.file)! });
  }
  return { declarations, externals, files, relationships: [...fileRelationships.values()].flat(), internalSites, unresolvedOccurrences };
}

function statesFor(root: string, program: Ts7Host, configured: readonly ConfiguredProject[]): FileState[] {
  const owner = new Map<string, ConfiguredProject>();
  for (const project of configured) for (const file of project.files) if (!owner.has(file)) owner.set(file, project);
  return [...owner].sort(([left], [right]) => left.localeCompare(right)).flatMap(([absolute, configuredProject]) => {
    const source = program.sourceFile(configuredProject.config, absolute);
    const project = program.withSnapshot((snapshot) => snapshot.getProject(configuredProject.config));
    if (!source || !project) return [];
    const file = relative(root, absolute);
    const descriptors = describeFile(file, source.text);
    const indexed = descriptors.filter(isIndexedDeclaration);
    const byStart = new Map(indexed.map((descriptor) => [descriptor.start, descriptor]));
    const nodesByStart = new Map<number, ts.Node>();
    const collectNodes = (node: ts.Node): void => {
      if (!nodesByStart.has(node.getStart(source))) nodesByStart.set(node.getStart(source), node);
      node.forEachChild(collectNodes);
    };
    source.forEachChild(collectNodes);
    return [{
      absolute,
      file,
      source,
      project,
      checker: project.checker,
      descriptors,
      indexed,
      byStart,
      nodesByStart,
    }];
  });
}

function ownerForNode(state: FileState, node: ts.Node): KeyedDeclaration {
  for (let current: ts.Node | undefined = node; current && !ts.isSourceFile(current); current = current.parent) {
    const descriptor = state.byStart.get(current.getStart(state.source));
    if (descriptor) return descriptor;
  }
  return state.indexed.find((descriptor) => descriptor.scope === 'module')!;
}

function declarationSymbolTargets(states: readonly FileState[]): Map<number, string | null> {
  const targets = new Map<number, string | null>();
  for (const state of states) {
    const descriptors = state.descriptors.filter((descriptor) => descriptor.scope !== 'module');
    const symbols = state.checker.getSymbolAtPosition(state.absolute, descriptors.map((descriptor) => descriptor.nameStart));
    for (let index = 0; index < descriptors.length; index++) {
      const descriptor = descriptors[index]!;
      const symbol = symbols[index];
      if (!symbol) continue;
      const key = isIndexedDeclaration(descriptor) ? descriptor.key : null;
      if (key !== null || !targets.has(symbol.id)) targets.set(symbol.id, key);
    }
  }
  return targets;
}

function declarationNode(state: FileState, descriptor: KeyedDeclaration): DeclarationNode {
  const name = state.source.getLineAndCharacterOfPosition(descriptor.nameStart);
  const end = state.source.getLineAndCharacterOfPosition(descriptor.end);
  const declaration = state.nodesByStart.get(descriptor.start);
  const kind = declarationKind(descriptor, declaration);
  const container = descriptor.scope === 'module' ? null : declaration ? ownerForNode(state, declaration.parent).key : `${state.file}#<module>`;
  const dir = path.posix.dirname(state.file);
  const segments = state.file.split('/');
  return {
    key: descriptor.key,
    at: `${state.file}:${name.line + 1}:${name.character + 1}`,
    name: descriptor.name,
    qname: descriptor.path,
    kind,
    exported: descriptor.scope !== 'module' && !!declaration && isExported(declaration),
    file: state.file,
    dir: dir === '.' ? '' : dir,
    top: segments.length >= 2 ? `${segments[0]}/${segments[1]}` : dir,
    line: descriptor.scope === 'module' ? 0 : name.line + 1,
    col: descriptor.scope === 'module' ? 0 : name.character + 1,
    endLine: end.line + 1,
    lines: Math.max(1, end.line - name.line + 1),
    declCount: 1,
    container,
  };
}

function declarationKind(descriptor: KeyedDeclaration, node: ts.Node | undefined): DeclarationKind {
  switch (descriptor.kind) {
    case 'FunctionDeclaration': return 'function';
    case 'ClassDeclaration':
    case 'ClassExpression': return 'class';
    case 'InterfaceDeclaration': return 'interface';
    case 'TypeAliasDeclaration': return 'type';
    case 'EnumDeclaration': return 'enum';
    case 'ModuleDeclaration': return 'namespace';
    case 'MethodDeclaration':
    case 'MethodSignature': return 'method';
    case 'PropertyDeclaration':
    case 'PropertySignature':
    case 'EnumMember': return 'property';
    case 'GetAccessor': return 'getter';
    case 'SetAccessor': return 'setter';
    case 'Constructor': return 'constructor';
    case 'VariableDeclaration': return variableKind(node);
    default: return descriptor.scope === 'module' ? 'module' : 'property';
  }
}

function variableKind(node: ts.Node | undefined): 'const' | 'let' | 'var' {
  const parent = node?.parent;
  const flags = parent && ts.isVariableDeclarationList(parent) ? parent.flags : 0;
  if (flags & ts.NodeFlags.Const) return 'const';
  if (flags & ts.NodeFlags.Let) return 'let';
  return 'var';
}

function isExported(node: ts.Node): boolean {
  if ((node as ts.Node & { modifiers?: readonly ts.Node[] }).modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return true;
  if (ts.isExportAssignment(node)) return true;
  let current: ts.Node | undefined = node.parent;
  while (current && !ts.isVariableStatement(current) && !ts.isSourceFile(current)) current = current.parent;
  return !!current && ts.isVariableStatement(current) && (current as ts.Node & { modifiers?: readonly ts.Node[] }).modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) === true;
}

function callCallee(node: ts.Node): ts.Node | null {
  let expression: ts.Expression | ts.JsxTagNameExpression | undefined;
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) expression = node.expression;
  else if (ts.isTaggedTemplateExpression(node)) expression = node.tag;
  else if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) expression = node.tagName;
  else return null;
  return ts.isPropertyAccessExpression(expression) ? expression.name : expression;
}

function referenceRole(node: ts.Identifier, call: boolean): ReferenceRole {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (ts.isImportDeclaration(current) || ts.isImportSpecifier(current) || ts.isNamespaceImport(current) || ts.isImportClause(current) || ts.isExportSpecifier(current)) return 'import';
    if (isTypeNode(current)) return 'type';
    if (call) return 'call';
    if (isWrite(node, current)) return 'write';
  }
  return isDeclarationName(node) ? 'definition' : 'read';
}

function isDeclarationName(node: ts.Identifier): boolean {
  if ((node.parent as ts.Node & { name?: ts.Node }).name !== node) return false;
  switch (node.parent.kind) {
    case ts.SyntaxKind.FunctionDeclaration:
    case ts.SyntaxKind.ClassDeclaration:
    case ts.SyntaxKind.InterfaceDeclaration:
    case ts.SyntaxKind.TypeAliasDeclaration:
    case ts.SyntaxKind.EnumDeclaration:
    case ts.SyntaxKind.ModuleDeclaration:
    case ts.SyntaxKind.VariableDeclaration:
    case ts.SyntaxKind.BindingElement:
    case ts.SyntaxKind.Parameter:
    case ts.SyntaxKind.TypeParameter:
    case ts.SyntaxKind.MethodDeclaration:
    case ts.SyntaxKind.MethodSignature:
    case ts.SyntaxKind.PropertyDeclaration:
    case ts.SyntaxKind.PropertySignature:
    case ts.SyntaxKind.PropertyAssignment:
    case ts.SyntaxKind.ShorthandPropertyAssignment:
    case ts.SyntaxKind.EnumMember:
    case ts.SyntaxKind.GetAccessor:
    case ts.SyntaxKind.SetAccessor:
      return true;
    default:
      return false;
  }
}

function isWrite(node: ts.Identifier, current: ts.Node): boolean {
  if ((ts.isBinaryExpression(current) && current.left === node && current.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && current.operatorToken.kind <= ts.SyntaxKind.LastAssignment) || ts.isPrefixUnaryExpression(current) || ts.isPostfixUnaryExpression(current)) return true;
  return false;
}

function isTypeNode(node: ts.Node): node is ts.TypeNode {
  return node.kind >= ts.SyntaxKind.FirstTypeNode && node.kind <= ts.SyntaxKind.LastTypeNode;
}

function firstIdentifier(node: ts.Node): ts.Identifier | undefined {
  if (ts.isIdentifier(node)) return node;
  return node.forEachChild(firstIdentifier);
}

function typePosition(node: ts.TypeNode): TypePosition {
  const parent = node.parent;
  if (ts.isParameterDeclaration(parent)) return 'parameter';
  if (isFunctionLike(parent)) return 'return';
  if (ts.isPropertyDeclaration(parent) || parent.kind === ts.SyntaxKind.PropertySignature) return 'property';
  if (ts.isVariableDeclaration(parent)) return 'variable';
  return 'type';
}

function isFunctionLike(node: ts.Node): boolean {
  return node.kind === ts.SyntaxKind.FunctionDeclaration || node.kind === ts.SyntaxKind.FunctionExpression || node.kind === ts.SyntaxKind.ArrowFunction || node.kind === ts.SyntaxKind.MethodDeclaration || node.kind === ts.SyntaxKind.MethodSignature || node.kind === ts.SyntaxKind.GetAccessor || node.kind === ts.SyntaxKind.SetAccessor || node.kind === ts.SyntaxKind.Constructor || node.kind === ts.SyntaxKind.CallSignature || node.kind === ts.SyntaxKind.ConstructSignature || node.kind === ts.SyntaxKind.IndexSignature;
}

function importNames(node: ts.ImportDeclaration, source: ts.SourceFile): string {
  const clause = node.importClause;
  return clause ? clause.getText(source).replace(/^type\s+/, '') : '*';
}

function directExports(state: FileState, add: (relationship: IndexRelationship) => void): void {
  for (const descriptor of state.indexed) {
    const node = state.nodesByStart.get(descriptor.start);
    if (!node || !isExported(node)) continue;
    const site = state.source.getLineAndCharacterOfPosition(descriptor.nameStart);
    add({ type: 'EXPORTS', from: `${state.file}#<module>`, to: descriptor.key, name: descriptor.name, line: site.line + 1, col: site.character + 1 });
  }
}

function exportDeclaration(stateNode: ts.ExportDeclaration, state: FileState, lookup: DeclarationLookup, addTarget: (target: Target, unresolved: boolean) => string | null, add: (relationship: IndexRelationship) => void, alias: (symbol: TsSymbol) => TsSymbol): void {
  const clause = stateNode.exportClause;
  if (!clause || !ts.isNamedExports(clause)) return;
  for (const element of clause.elements) {
    const symbol = state.checker.getExportSpecifierLocalTargetSymbol(element);
    const target = symbol ? declarationTarget(symbol, lookup, alias) : null;
    const key = addTarget(target, !symbol);
    if (!key || target?.external) continue;
    const site = state.source.getLineAndCharacterOfPosition(element.name.getStart(state.source));
    add({ type: 'EXPORTS', from: `${state.file}#<module>`, to: key, name: element.name.text, line: site.line + 1, col: site.character + 1 });
  }
}
