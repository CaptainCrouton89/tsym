import path from 'node:path';
import type { Symbol as TsSymbol } from 'typescript/unstable/sync';
import type { Node } from '../ts7/ast.js';
import type { KeyedDeclaration } from './descriptor.js';
import type { ExternalNode } from './graph.js';

export type Target = { key: string; external: false } | { key: string; external: true; node: ExternalNode } | null;

export interface DeclarationLookup {
  root: string;
  indexedByStart: ReadonlyMap<string, ReadonlyMap<number, KeyedDeclaration>>;
  modulesByFile: ReadonlyMap<string, string>;
}

export function declarationTarget(symbol: TsSymbol, lookup: DeclarationLookup, resolveAlias: (symbol: TsSymbol) => TsSymbol, externalIdentity?: string): Target {
  const resolved = resolveAlias(symbol);
  const declarations = resolved.declarations;
  for (const handle of declarations) {
    const declaration = handle.resolve();
    if (!declaration) continue;
    const file = relative(lookup.root, declaration.getSourceFile().fileName);
    const descriptor = lookup.indexedByStart.get(file)?.get(declaration.getStart(declaration.getSourceFile()));
    if (descriptor) return { key: descriptor.key, external: false };
  }
  if (declarations.some((handle) => {
    const declaration = handle.resolve();
    return declaration && lookup.modulesByFile.has(relative(lookup.root, declaration.getSourceFile().fileName));
  })) return null;
  const declaration = declarations.map((handle) => handle.resolve()).find((node): node is Node => !!node);
  const module = externalModule(declaration?.getSourceFile().fileName, externalIdentity ?? resolved.name);
  const name = resolved.name;
  const node = { key: `${module}#${name}`, module, name };
  return { key: node.key, external: true, node };
}

export function moduleTarget(symbol: TsSymbol | undefined, lookup: DeclarationLookup, resolveAlias: (symbol: TsSymbol) => TsSymbol, specifier: string): Target {
  if (symbol) {
    const declarations = resolveAlias(symbol).declarations;
    for (const handle of declarations) {
      const declaration = handle.resolve();
      if (!declaration) continue;
      const key = lookup.modulesByFile.get(relative(lookup.root, declaration.getSourceFile().fileName));
      if (key) return { key, external: false };
    }
  }
  const module = packageName(specifier);
  const node = { key: `${module}#<module>`, module, name: '<module>' };
  return { key: node.key, external: true, node };
}

export function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export function packageName(specifier: string): string {
  const segments = specifier.split('/');
  if (specifier.startsWith('@')) return segments[1]?.endsWith('.js') ? segments[0]! : segments.slice(0, 2).join('/');
  return segments[0] || specifier;
}

function externalModule(file: string | undefined, fallback: string): string {
  if (!file) return fallback;
  const normalized = file.split(path.sep).join('/');
  if (/\/lib\.[^.]+\.d\.ts$/.test(normalized)) return 'lib';
  const nodeModules = normalized.lastIndexOf('/node_modules/');
  if (nodeModules >= 0) return packageName(normalized.slice(nodeModules + '/node_modules/'.length));
  return fallback;
}
