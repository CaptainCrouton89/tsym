import path from 'node:path';
import { Node } from 'ts-morph';
import { finish } from './receipt.js';
import { resolveSymbol, type ResolveOptions } from './symbols.js';
import { lineTextAt, locOf, nameIdentifier, referencesTo, type NameNode } from './ts-program.js';
import type { Caller, Result } from './types.js';
import type { Workspace } from './workspace.js';

export interface CallersOptions extends ResolveOptions {
  limit?: number | null;
}

/** Functions and methods that call the symbol (call, `new`, tagged template, or JSX element), one row per caller. */
export async function callers(ws: Workspace, address: string, opts: CallersOptions = {}): Promise<Result<Caller>> {
  const startedAt = performance.now();
  const symbol = await resolveSymbol(ws, address, opts);
  const id = nameIdentifier(ws, symbol);
  const items = callersOf(ws, id, 1);
  return finish({ command: 'callers', query: address, root: ws.root, engine: 'ts-morph', filesScanned: ws.projectFor(symbol.path).getSourceFiles().length, startedAt, limit: opts.limit }, items);
}

/** Direct callers of the declaration named by `id`, each carrying the identifier that names it (for recursion). */
export function callersOf(ws: Workspace, id: NameNode, depth: number): Array<Caller & { id: NameNode | null }> {
  const byKey = new Map<string, Caller & { id: NameNode | null }>();
  for (const ref of referencesTo(id)) {
    const node = ref.getNode();
    if (!isCallSite(node)) continue;
    const caller = enclosingCaller(ws, node, depth);
    const key = `${caller.path}:${caller.start.line}:${caller.start.col}`;
    const existing = byKey.get(key);
    if (existing) existing.callSites += 1;
    else byKey.set(key, caller);
  }
  return [...byKey.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line));
}

function isCallSite(n: Node): boolean {
  const p = n.getParent();
  if (!p) return false;
  if (Node.isCallExpression(p) || Node.isNewExpression(p)) return p.getExpression() === n;
  if (Node.isTaggedTemplateExpression(p)) return p.getTag() === n;
  if (Node.isJsxOpeningElement(p) || Node.isJsxSelfClosingElement(p)) return p.getTagNameNode() === n;
  if (Node.isPropertyAccessExpression(p) && p.getNameNode() === n) {
    const gp = p.getParent();
    return !!gp && ((Node.isCallExpression(gp) || Node.isNewExpression(gp)) && gp.getExpression() === p);
  }
  return false;
}

type FunctionLike = Node & { getBody?: () => Node | undefined };

function isFunctionLike(n: Node): boolean {
  return Node.isFunctionDeclaration(n) || Node.isMethodDeclaration(n) || Node.isArrowFunction(n) || Node.isFunctionExpression(n) || Node.isConstructorDeclaration(n) || Node.isGetAccessorDeclaration(n) || Node.isSetAccessorDeclaration(n);
}

/** The named function or method that contains `site`; anonymous callbacks attribute to the nearest named ancestor. */
function enclosingCaller(ws: Workspace, site: Node, depth: number): Caller & { id: NameNode | null } {
  let cur: Node | undefined = site.getParent();
  while (cur) {
    if (isFunctionLike(cur)) {
      const named = nameOf(cur as FunctionLike);
      if (named) {
        const decl = declarationOf(cur);
        return { ...locOf(ws, decl), kind: named.kind, name: named.name, qualifiedName: named.qualifiedName, depth, callSites: 1, text: lineTextAt(decl), id: named.id };
      }
    }
    cur = cur.getParent();
  }
  const sf = site.getSourceFile();
  const rel = ws.rel(sf.getFilePath());
  return { path: rel, start: { line: 1, col: 1 }, end: { line: sf.getEndLineNumber(), col: 1 }, kind: 'module', name: path.basename(rel), qualifiedName: rel, depth, callSites: 1, text: '(module scope)', id: null };
}

/** The statement or member that declares a function-like node: `const f = () => …` reports the whole `const` statement. */
function declarationOf(fn: Node): Node {
  const p = fn.getParent();
  if (p && Node.isVariableDeclaration(p)) return p.getVariableStatement() ?? p;
  if (p && (Node.isPropertyAssignment(p) || Node.isPropertyDeclaration(p))) return p;
  return fn;
}

interface Named {
  kind: Caller['kind'];
  name: string;
  qualifiedName: string;
  id: NameNode | null;
}

function nameOf(fn: FunctionLike): Named | null {
  if (Node.isFunctionDeclaration(fn)) {
    const id = fn.getNameNode() ?? null;
    return { kind: 'function', name: id?.getText() ?? 'default', qualifiedName: id?.getText() ?? 'default', id };
  }
  if (Node.isMethodDeclaration(fn) || Node.isGetAccessorDeclaration(fn) || Node.isSetAccessorDeclaration(fn)) {
    const nameNode = fn.getNameNode();
    const id = Node.isIdentifier(nameNode) || Node.isPrivateIdentifier(nameNode) ? nameNode : null;
    return { kind: 'method', name: nameNode.getText(), qualifiedName: qualify(fn, nameNode.getText()), id };
  }
  if (Node.isConstructorDeclaration(fn)) {
    const owner = fn.getParent();
    const ownerId = Node.isClassDeclaration(owner) ? (owner.getNameNode() ?? null) : null;
    return { kind: 'method', name: 'constructor', qualifiedName: qualify(fn, 'constructor'), id: ownerId };
  }
  // Arrow function / function expression: named by what it is assigned to.
  const p = fn.getParent();
  if (Node.isVariableDeclaration(p)) {
    const nameNode = p.getNameNode();
    if (Node.isIdentifier(nameNode)) return { kind: 'function', name: nameNode.getText(), qualifiedName: nameNode.getText(), id: nameNode };
  }
  if (Node.isPropertyAssignment(p) || Node.isPropertyDeclaration(p)) {
    const nameNode = p.getNameNode();
    const id = Node.isIdentifier(nameNode) || Node.isPrivateIdentifier(nameNode) ? nameNode : null;
    return { kind: Node.isPropertyDeclaration(p) ? 'method' : 'function', name: nameNode.getText(), qualifiedName: qualify(p, nameNode.getText()), id };
  }
  return null;
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
