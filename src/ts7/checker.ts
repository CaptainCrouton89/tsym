import path from 'node:path';
import { DiagnosticCategory, type Diagnostic, type Project, type Type } from 'typescript/unstable/sync';
import { SyntaxKind, isFunctionLikeDeclaration, isTypeNode, type Node, type TypeNode } from 'typescript/unstable/ast';
import { Ts7Host } from './api.js';

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
