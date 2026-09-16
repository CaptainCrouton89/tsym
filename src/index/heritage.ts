import { SymbolFlags, type Checker, type Symbol as TsSymbol } from 'typescript/unstable/sync';
import * as ts from '../ts7/ast.js';
import { Ts7Host } from '../ts7/api.js';
import { ConfiguredProjects } from '../ts7/projects.js';
import type { CallRelationship, IndexGraph, IndexRelationship } from './graph.js';
import { isIndexedDeclaration } from './scope.js';
import { relative } from './classify.js';
import { walkFileStates, type WalkFileState } from './walk.js';

export interface HeritageRelationship { type: 'EXTENDS' | 'IMPLEMENTS'; from: string; to: string; }

export interface HeritageGraph {
  graph: IndexGraph;
  relationships: readonly HeritageRelationship[];
  dispatchCalls: number;
}


/** Adds compiler-resolved heritage edges and marks calls that require implementation dispatch. */
export function addHeritage(root: string, program: Ts7Host, projects: ConfiguredProjects, graph: IndexGraph): HeritageGraph {
  const states = walkFileStates(graph);
  const stateByFile = new Map(states.map((state) => [state.file, state]));
  const declarationsByKey = new Map<string, ts.Node[]>();
  for (const state of states) for (const descriptor of state.descriptors) {
    if (!graph.declarations.has(descriptor.key)) continue;
    const node = state.nodesByStart.get(descriptor.start);
    if (!node) continue;
    const nodes = declarationsByKey.get(descriptor.key) ?? [];
    nodes.push(node);
    declarationsByKey.set(descriptor.key, nodes);
  }
  const targetKey = (checker: Checker, symbol: TsSymbol | undefined): string | undefined => {
    if (!symbol) return undefined;
    const resolved = symbol.flags & SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    for (const handle of resolved.declarations) {
      const declaration = handle.resolve();
      if (!declaration) continue;
      const file = relative(root, declaration.getSourceFile().fileName);
      const state = stateByFile.get(file);
      const descriptor = state?.byStart.get(declaration.getStart(declaration.getSourceFile()));
      if (descriptor && graph.declarations.has(descriptor.key)) return descriptor.key;
    }
    return undefined;
  };
  const relationships = new Map<string, HeritageRelationship>();
  const add = (relationship: HeritageRelationship): void => { relationships.set(`${relationship.type}:${relationship.from}:${relationship.to}`, relationship); };

  for (const state of states) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) || ts.isClassExpression(node) || ts.isInterfaceDeclaration(node)) {
        const source = state.byStart.get(node.getStart(state.source));
        if (source && graph.declarations.has(source.key)) {
          for (const clause of node.heritageClauses ?? []) {
            for (const type of clause.types) {
              const target = targetKey(state.checker, state.checker.getSymbolAtLocation(type.expression));
              if (!target) continue;
              if (clause.token === ts.SyntaxKind.ImplementsKeyword && (ts.isClassDeclaration(node) || ts.isClassExpression(node))) {
                add({ type: 'IMPLEMENTS', from: source.key, to: target });
                addMatchingMembers(node, state, target, targetKey, declarationsByKey, add);
              } else if (clause.token === ts.SyntaxKind.ExtendsKeyword) add({ type: 'EXTENDS', from: source.key, to: target });
            }
          }
        }
      }
      node.forEachChild(visit);
    };
    state.source.forEachChild(visit);
  }

  const dispatch = (target: string): boolean => (declarationsByKey.get(target) ?? []).some(isDispatchTarget);
  const decoratedRelationships = graph.relationships.map((relationship): IndexRelationship => relationship.type === 'CALLS'
    ? { ...relationship, dispatch: dispatch(relationship.to) }
    : relationship);
  const decoratedByFile = new Map<string, IndexRelationship[]>();
  for (const relationship of decoratedRelationships) {
    const file = graph.declarations.get(relationship.from)?.file;
    if (file) (decoratedByFile.get(file) ?? decoratedByFile.set(file, []).get(file)!).push(relationship);
  }
  const files = new Map([...graph.files].map(([file, record]) => [file, { ...record, relationships: decoratedByFile.get(file) ?? [] }]));
  const decorated = { ...graph, files, relationships: decoratedRelationships };
  const dispatchCalls = decoratedRelationships.filter((relationship): relationship is CallRelationship => relationship.type === 'CALLS' && relationship.dispatch).length;
  return { graph: decorated, relationships: [...relationships.values()], dispatchCalls };
}

function addMatchingMembers(node: ts.ClassDeclaration | ts.ClassExpression, state: WalkFileState, target: string, targetKey: (checker: Checker, symbol: TsSymbol | undefined) => string | undefined, declarationsByKey: ReadonlyMap<string, readonly ts.Node[]>, add: (relationship: HeritageRelationship) => void): void {
  const targetDeclaration = declarationsByKey.get(target)?.find((candidate) => ts.isInterfaceDeclaration(candidate));
  if (!targetDeclaration || !ts.isInterfaceDeclaration(targetDeclaration)) return;
  const targetType = state.checker.getTypeAtLocation(targetDeclaration.name);
  if (!targetType) return;
  for (const member of node.members) {
    const descriptor = state.byStart.get(member.getStart(state.source));
    const name = memberName(member);
    if (!descriptor || !name || !isIndexedDeclaration(descriptor) || hasModifier(member, ts.SyntaxKind.AbstractKeyword)) continue;
    const interfaceMember = state.checker.getPropertyOfType(targetType, name);
    const memberTarget = targetKey(state.checker, interfaceMember);
    if (memberTarget) add({ type: 'IMPLEMENTS', from: descriptor.key, to: memberTarget });
  }
}

function memberName(node: ts.Node): string | undefined {
  const name = (node as ts.Node & { name?: ts.Node & { text?: string } }).name;
  return name?.text;
}

function isDispatchTarget(node: ts.Node): boolean {
  if (ts.isMethodSignatureDeclaration(node)) return true;
  if (!(ts.isMethodDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isVariableDeclaration(node))) return false;
  if (hasModifier(node, ts.SyntaxKind.AbstractKeyword) || hasModifier(node, ts.SyntaxKind.DeclareKeyword)) return true;
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (hasModifier(current, ts.SyntaxKind.DeclareKeyword)) return true;
    if (ts.isSourceFile(current)) return current.fileName.endsWith('.d.ts');
  }
  return false;
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return (node as ts.Node & { modifiers?: readonly { kind: ts.SyntaxKind }[] }).modifiers?.some((modifier) => modifier.kind === kind) === true;
}
