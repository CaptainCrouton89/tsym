import path from 'node:path';
import { Node, SyntaxKind } from 'ts-morph';
import { lineTextAt, locOf, type NameNode } from './ts-program.js';
import type { Callee, UnresolvedEdge } from './types.js';
import type { Workspace } from './workspace.js';

type FunctionLike = Node & { getBody?: () => Node | undefined };

interface ResolvedCallee extends Callee {
  declaration: Node;
  callable: Node;
}

export interface CalleesResult {
  items: ResolvedCallee[];
  unresolved: UnresolvedEdge[];
}

/** Direct callees in a declaration body, grouped by callee declaration. */
export function calleesOf(ws: Workspace, declaration: Node, depth: number): CalleesResult {
  const owner = Node.isSourceFile(declaration) ? declaration : callableInfo(declaration)?.body;
  if (!owner) return { items: [], unresolved: [] };

  const byKey = new Map<string, ResolvedCallee>();
  const unresolved: UnresolvedEdge[] = [];
  for (const site of callSites(owner)) {
    const callee = calleeIdentifier(site);
    if (!callee) {
      unresolved.push(unresolvedEdge(ws, owner, site, 'dynamic'));
      continue;
    }
    const resolved = resolveCallee(ws, callee);
    if (resolved.kind === 'external') {
      unresolved.push(unresolvedEdge(ws, owner, site, 'external'));
      continue;
    }
    if (resolved.kind === 'unresolved') {
      unresolved.push(unresolvedEdge(ws, owner, site, resolved.reason));
      continue;
    }
    const row = calleeRow(ws, resolved.info, depth);
    const key = address(row);
    const existing = byKey.get(key);
    if (existing) existing.callSites += 1;
    else byKey.set(key, row);
  }

  return {
    items: [...byKey.values()].sort(compareCallees),
    unresolved,
  };
}

function callSites(owner: Node): Node[] {
  const sites = [
    ...owner.getDescendantsOfKind(SyntaxKind.CallExpression),
    ...owner.getDescendantsOfKind(SyntaxKind.NewExpression),
    ...owner.getDescendantsOfKind(SyntaxKind.TaggedTemplateExpression),
    ...owner.getDescendantsOfKind(SyntaxKind.JsxOpeningElement),
    ...owner.getDescendantsOfKind(SyntaxKind.JsxSelfClosingElement),
  ];
  return sites.filter((site) => Node.isSourceFile(owner) ? nearestCallable(site) === undefined : nearestCallable(site) === owner);
}

function nearestCallable(node: Node): Node | undefined {
  let cur: Node | undefined = node.getParent();
  while (cur) {
    const info = callableInfo(cur);
    if (info?.body === cur) return cur;
    cur = cur.getParent();
  }
  return undefined;
}

function calleeIdentifier(site: Node): NameNode | null {
  let expression: Node | undefined;
  if (Node.isCallExpression(site) || Node.isNewExpression(site)) expression = site.getExpression();
  else if (Node.isTaggedTemplateExpression(site)) expression = site.getTag();
  else if (Node.isJsxOpeningElement(site) || Node.isJsxSelfClosingElement(site)) expression = site.getTagNameNode();
  if (!expression) return null;
  if (Node.isPropertyAccessExpression(expression)) return expression.getNameNode();
  return Node.isIdentifier(expression) || Node.isPrivateIdentifier(expression) ? expression : null;
}

type Resolution = { kind: 'resolved'; info: CallableInfo } | { kind: 'external' } | { kind: 'unresolved'; reason: 'dispatch' | 'dynamic' };

function resolveCallee(ws: Workspace, callee: NameNode): Resolution {
  const definitions = callee.getDefinitionNodes();
  if (definitions.length === 0) return { kind: 'unresolved', reason: 'dynamic' };

  let dispatch = false;
  let dynamic = false;
  for (const definition of definitions) {
    if (isExternal(definition)) continue;
    if (isAmbient(definition)) {
      dynamic = true;
      continue;
    }
    if (isDispatch(definition)) {
      dispatch = true;
      continue;
    }
    const info = callableInfo(definition);
    if (info) return { kind: 'resolved', info };
    else dynamic = true;
  }
  if (definitions.every(isExternal)) return { kind: 'external' };
  return { kind: 'unresolved', reason: dispatch ? 'dispatch' : dynamic ? 'dynamic' : 'dynamic' };
}

function isExternal(node: Node): boolean {
  const file = node.getSourceFile().getFilePath().split(path.sep).join('/');
  return file.includes('/node_modules/') || /\/lib\.[^/]+\.d\.ts$/.test(file);
}

function isAmbient(node: Node): boolean {
  if (node.getSourceFile().isDeclarationFile()) return true;
  if (Node.isFunctionDeclaration(node) && node.hasDeclareKeyword()) return true;
  const statement = node.getFirstAncestorByKind(SyntaxKind.VariableStatement);
  return statement?.hasDeclareKeyword() ?? false;
}

function isDispatch(node: Node): boolean {
  if (Node.isMethodSignature(node) || Node.isPropertySignature(node)) return true;
  if (Node.isMethodDeclaration(node) && node.hasModifier(SyntaxKind.AbstractKeyword)) return true;
  return false;
}

interface CallableInfo {
  declaration: Node;
  body: Node | undefined;
  kind: Callee['kind'];
  name: string;
  qualifiedName: string;
}

function callableInfo(node: Node): CallableInfo | null {
  if (Node.isIdentifier(node) || Node.isPrivateIdentifier(node)) {
    let parent: Node | undefined = node.getParent();
    while (parent) {
      const info = callableInfo(parent);
      if (info) return info;
      parent = parent.getParent();
    }
    return null;
  }
  if (Node.isVariableDeclaration(node)) {
    const initializer = node.getInitializer();
    if (initializer && isFunctionLike(initializer)) return functionInfo(initializer, declarationOf(initializer));
    return null;
  }
  if (Node.isPropertyAssignment(node) || Node.isPropertyDeclaration(node)) {
    const initializer = node.getInitializer();
    if (initializer && isFunctionLike(initializer)) return functionInfo(initializer, declarationOf(initializer));
    return null;
  }
  if (Node.isClassDeclaration(node) || Node.isClassExpression(node)) {
    const constructor = node.getConstructors()[0];
    const name = node.getName() ?? 'default';
    return { declaration: node, body: constructor, kind: 'class', name, qualifiedName: name };
  }
  if (isFunctionLike(node)) return functionInfo(node, declarationOf(node));
  return null;
}

function isFunctionLike(node: Node): node is FunctionLike {
  return Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node) || Node.isArrowFunction(node) || Node.isFunctionExpression(node) || Node.isConstructorDeclaration(node) || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node);
}

function functionInfo(fn: FunctionLike, declaration: Node): CallableInfo | null {
  if (Node.isFunctionDeclaration(fn)) {
    const name = fn.getName() ?? 'default';
    return { declaration, body: fn, kind: 'function', name, qualifiedName: name };
  }
  if (Node.isMethodDeclaration(fn) || Node.isGetAccessorDeclaration(fn) || Node.isSetAccessorDeclaration(fn)) {
    const name = fn.getName();
    return { declaration, body: fn, kind: 'method', name, qualifiedName: qualify(fn, name) };
  }
  if (Node.isConstructorDeclaration(fn)) {
    const owner = fn.getParent();
    if (!Node.isClassDeclaration(owner) && !Node.isClassExpression(owner)) return null;
    const name = owner.getName() ?? 'default';
    return { declaration: owner, body: fn, kind: 'class', name, qualifiedName: name };
  }
  const parent = fn.getParent();
  if (Node.isVariableDeclaration(parent)) {
    const name = parent.getName();
    return { declaration, body: fn, kind: 'function', name, qualifiedName: name };
  }
  if (Node.isPropertyAssignment(parent) || Node.isPropertyDeclaration(parent)) {
    const name = parent.getName();
    return { declaration, body: fn, kind: Node.isPropertyDeclaration(parent) ? 'method' : 'function', name, qualifiedName: qualify(parent, name) };
  }
  return null;
}

function declarationOf(fn: Node): Node {
  const parent = fn.getParent();
  if (parent && Node.isVariableDeclaration(parent)) {
    const statement = parent.getVariableStatement();
    return statement && statement.getDeclarations().length === 1 ? statement : parent;
  }
  if (parent && (Node.isPropertyAssignment(parent) || Node.isPropertyDeclaration(parent))) return parent;
  return fn;
}

function qualify(member: Node, name: string): string {
  const owner = member.getParent();
  if (Node.isClassDeclaration(owner) || Node.isClassExpression(owner)) return `${owner.getName() ?? '(class)'}.${name}`;
  if (Node.isObjectLiteralExpression(owner)) {
    const holder = owner.getParent();
    if (Node.isVariableDeclaration(holder)) return `${holder.getName()}.${name}`;
  }
  return name;
}

function calleeRow(ws: Workspace, info: CallableInfo, depth: number): ResolvedCallee {
  return { ...locOf(ws, info.declaration), kind: info.kind, name: info.name, qualifiedName: info.qualifiedName, depth, callSites: 1, text: lineTextAt(info.declaration), declaration: info.declaration, callable: info.body ?? info.declaration };
}

function unresolvedEdge(ws: Workspace, owner: Node, site: Node, reason: UnresolvedEdge['reason']): UnresolvedEdge {
  const expression = callExpression(site);
  return { from: address(locOf(ws, callableInfo(owner)?.declaration ?? owner)), name: expression.getText(), reason, ...locOf(ws, expression), text: lineTextAt(site) };
}

function callExpression(site: Node): Node {
  if (Node.isCallExpression(site) || Node.isNewExpression(site)) return site.getExpression();
  if (Node.isTaggedTemplateExpression(site)) return site.getTag();
  if (Node.isJsxOpeningElement(site) || Node.isJsxSelfClosingElement(site)) return site.getTagNameNode();
  return site;
}

function address(loc: { path: string; start: { line: number; col: number } }): string {
  return `${loc.path}:${loc.start.line}:${loc.start.col}`;
}

function compareCallees(a: Callee, b: Callee): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line || a.start.col - b.start.col;
}
