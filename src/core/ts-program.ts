import { Node, type Identifier, type PrivateIdentifier, type ReferenceEntry, type SourceFile } from 'ts-morph';

export type NameNode = Identifier | PrivateIdentifier;
import type { Loc, Symbol } from './types.js';
import type { Workspace } from './workspace.js';
import { projectFor } from './legacy-projects.js';

/** The ts-morph source file for a workspace-relative path, adding it to the program if the tsconfig excluded it. */
export function sourceFileFor(ws: Workspace, rel: string): SourceFile {
  const project = projectFor(ws, rel);
  const abs = ws.abs(rel);
  return project.getSourceFile(abs) ?? project.addSourceFileAtPath(abs);
}

/** The identifier node that names a declaration found by ast-grep. */
export function nameIdentifier(ws: Workspace, symbol: Symbol): NameNode {
  const sf = sourceFileFor(ws, symbol.path);
  const pos = sf.compilerNode.getPositionOfLineAndCharacter(symbol.namePos.line - 1, symbol.namePos.col - 1);
  const node = sf.getDescendantAtPos(pos);
  if (!node || !(Node.isIdentifier(node) || Node.isPrivateIdentifier(node))) {
    throw new Error(`${symbol.path}:${symbol.namePos.line}:${symbol.namePos.col} is not an identifier in the TypeScript program (${node?.getKindName() ?? 'nothing'})`);
  }
  return node;
}

/** The source declaration to inspect for a symbol, including synthetic module and re-export graph nodes. */
export function declarationForSymbol(ws: Workspace, symbol: Symbol): Node {
  const sf = sourceFileFor(ws, symbol.path);
  if (symbol.kind === 'module') return sf;
  if (symbol.kind === 'export') {
    const pos = sf.compilerNode.getPositionOfLineAndCharacter(symbol.start.line - 1, symbol.start.col - 1);
    let node = sf.getDescendantAtPos(pos);
    while (node && !Node.isExportDeclaration(node)) node = node.getParent();
    if (node) return node;
    throw new Error(`${symbol.path}:${symbol.start.line}:${symbol.start.col} is not an export declaration in the TypeScript program`);
  }
  return nameIdentifier(ws, symbol);
}

/** Every reference to the identifier's symbol, excluding the declarations themselves. */
export function referencesTo(id: NameNode): ReferenceEntry[] {
  const out: ReferenceEntry[] = [];
  for (const sym of id.findReferences()) {
    for (const ref of sym.getReferences()) {
      if (ref.isDefinition()) continue;
      out.push(ref);
    }
  }
  return out;
}

export function locOf(ws: Workspace, node: Node): Loc {
  const sf = node.getSourceFile();
  const s = sf.getLineAndColumnAtPos(node.getStart());
  const e = sf.getLineAndColumnAtPos(node.getEnd());
  return { path: ws.rel(sf.getFilePath()), start: { line: s.line, col: s.column }, end: { line: e.line, col: e.column } };
}

export function lineTextAt(node: Node): string {
  const sf = node.getSourceFile();
  const text = sf.getFullText();
  const start = node.getStart();
  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  let lineEnd = text.indexOf('\n', start);
  if (lineEnd === -1) lineEnd = text.length;
  return text.slice(lineStart, lineEnd).trim();
}
