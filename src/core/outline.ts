import { parse, type SgNode, type SgRoot } from '@ast-grep/napi';
import { finish } from './receipt.js';
import type { Pos, Result, Symbol, SymbolKind } from './types.js';
import { langFor, type Workspace } from './workspace.js';

/** Symbols declared in one file: top-level declarations and class/interface/enum/namespace members. */
export function outline(ws: Workspace, file: string): Result<Symbol> {
  const startedAt = performance.now();
  const rel = ws.rel(ws.abs(file));
  const root = parseFile(ws, rel);
  const items = root ? outlineRoot(root, rel) : [];
  return finish({ command: 'outline', query: rel, root: ws.root, engine: 'ast-grep', filesScanned: root ? 1 : 0, startedAt }, items);
}

export function parseFile(ws: Workspace, rel: string): SgRoot | null {
  const lang = langFor(rel);
  if (lang === null) return null;
  return parse(lang, ws.read(rel));
}

/** Walk a parsed file and collect its symbols in source order. */
export function outlineRoot(root: SgRoot, rel: string): Symbol[] {
  const out: Symbol[] = [];
  for (const child of root.root().namedChildren()) visitTop(child, rel, null, out);
  return out;
}

function visitTop(node: SgNode, rel: string, scope: string | null, out: Symbol[]): void {
  let exported = false;
  let decl = node;
  if (node.kind() === 'export_statement') {
    const inner = node.field('declaration') ?? node.namedChildren().find((c) => c.kind() !== 'export_clause' && c.kind() !== 'string');
    if (!inner) return; // `export { a }` / `export * from` — not a declaration
    exported = true;
    decl = inner;
  } else if (node.kind() === 'ambient_declaration' || node.kind() === 'expression_statement') {
    const inner = node.namedChildren()[0];
    if (!inner) return;
    decl = inner;
  }

  const outer = exported ? node : decl;
  switch (decl.kind()) {
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'function_signature':
      push(out, outer, rel, scope, 'function', nameOf(decl, exported), exported, decl.field('name') ?? undefined);
      return;
    case 'function_expression':
    case 'arrow_function':
    case 'class':
      // `export default function () {}` / `export default class {}`
      if (exported) push(out, outer, rel, scope, decl.kind() === 'class' ? 'class' : 'function', 'default', exported);
      return;
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const name = nameOf(decl, exported);
      const sym = push(out, outer, rel, scope, 'class', name, exported, decl.field('name') ?? undefined);
      const body = decl.field('body');
      if (body) for (const m of body.namedChildren()) visitMember(m, rel, sym.qualifiedName, out);
      return;
    }
    case 'interface_declaration': {
      const name = nameOf(decl, exported);
      const sym = push(out, outer, rel, scope, 'interface', name, exported, decl.field('name') ?? undefined);
      const body = decl.field('body');
      if (body) for (const m of body.namedChildren()) visitMember(m, rel, sym.qualifiedName, out);
      return;
    }
    case 'type_alias_declaration':
      push(out, outer, rel, scope, 'type', nameOf(decl, exported), exported, decl.field('name') ?? undefined);
      return;
    case 'enum_declaration': {
      const sym = push(out, outer, rel, scope, 'enum', nameOf(decl, exported), exported, decl.field('name') ?? undefined);
      const body = decl.field('body');
      if (body) {
        for (const m of body.namedChildren()) {
          const name = m.kind() === 'enum_assignment' ? m.field('name')?.text() : m.text();
          if (name) push(out, m, rel, sym.qualifiedName, 'property', name, false);
        }
      }
      return;
    }
    case 'internal_module':
    case 'module': {
      const name = decl.field('name')?.text() ?? '(module)';
      const sym = push(out, outer, rel, scope, 'namespace', name, exported, decl.field('name') ?? undefined);
      const body = decl.field('body');
      if (body) for (const c of body.namedChildren()) visitTop(c, rel, sym.qualifiedName, out);
      return;
    }
    case 'lexical_declaration':
    case 'variable_declaration':
      const declarators = decl.namedChildren().filter((d) => d.kind() === 'variable_declarator');
      for (const d of declarators) {
        const rangeNode = declarators.length === 1 ? outer : d;
        const nameNode = d.field('name');
        if (!nameNode) continue;
        const value = d.field('value');
        const kind: SymbolKind = value && (value.kind() === 'arrow_function' || value.kind() === 'function_expression' || value.kind() === 'generator_function') ? 'function' : 'var';
        if (nameNode.kind() === 'identifier') {
          push(out, rangeNode, rel, scope, kind, nameNode.text(), exported, nameNode);
        } else {
          // destructuring: one symbol per bound identifier
          for (const id of boundIdentifiers(nameNode)) push(out, rangeNode, rel, scope, 'var', id.text(), exported, id);
        }
      }
      return;
    default:
      return;
  }
}

function visitMember(m: SgNode, rel: string, owner: string, out: Symbol[]): void {
  const nameNode = m.field('name');
  if (!nameNode) return;
  switch (m.kind()) {
    case 'method_definition':
    case 'method_signature':
    case 'abstract_method_signature':
      push(out, m, rel, owner, 'method', nameNode.text(), false, nameNode);
      return;
    case 'public_field_definition':
    case 'property_signature':
      push(out, m, rel, owner, 'property', nameNode.text(), false, nameNode);
      return;
    default:
      return;
  }
}

function boundIdentifiers(pattern: SgNode): SgNode[] {
  const out: SgNode[] = [];
  const visit = (n: SgNode): void => {
    const k = n.kind();
    if (k === 'shorthand_property_identifier_pattern' || k === 'identifier') {
      out.push(n);
      return;
    }
    if (k === 'pair_pattern') {
      const v = n.field('value');
      if (v) visit(v);
      return;
    }
    if (k === 'assignment_pattern') {
      const l = n.field('left');
      if (l) visit(l);
      return;
    }
    for (const c of n.namedChildren()) visit(c);
  };
  visit(pattern);
  return out;
}

function nameOf(decl: SgNode, exported: boolean): string {
  return decl.field('name')?.text() ?? (exported ? 'default' : '(anonymous)');
}

function push(out: Symbol[], node: SgNode, rel: string, scope: string | null, kind: SymbolKind, name: string, exported: boolean, nameNode?: SgNode): Symbol {
  const r = node.range();
  const nn = nameNode ?? node.field('name');
  const namePos: Pos = nn ? { line: nn.range().start.line + 1, col: nn.range().start.column + 1 } : { line: r.start.line + 1, col: r.start.column + 1 };
  const sym: Symbol = {
    path: rel,
    start: { line: r.start.line + 1, col: r.start.column + 1 },
    end: { line: r.end.line + 1, col: r.end.column + 1 },
    kind,
    name,
    qualifiedName: scope ? `${scope}.${name}` : name,
    exported,
    text: firstLine(node),
    namePos,
  };
  out.push(sym);
  return sym;
}

export function firstLine(node: SgNode): string {
  const nl = node.text().indexOf('\n');
  const line = nl === -1 ? node.text() : node.text().slice(0, nl);
  return line.trim();
}
