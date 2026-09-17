import { DeclarationError, type DeclarationRecord } from '../../core/declarations.js';
import { query } from '../../store/query.js';
import type { SemanticHandler } from '../handlers.js';

interface StoredSpan { endLine: number; lines: number; declCount: number; }

const handler: SemanticHandler = async (context, invocation) => {
  await context.projects.bootstrap();
  const started = performance.now();
  const resolved = await context.resolver.resolveAll(invocation.input.args);
  const rendered = [];
  for (const declaration of resolved) {
    const source = context.source.read(declaration.file);
    const span = storedSpan(context, declaration);
    const sites = declaration.location.line === 0 ? [{ source, span }] : await declarationSites(context, declaration, span);
    const text = declaration.location.line === 0 ? source : sites.map((site) => declarationText(site.source, site.span)).join('\n');
    const lines = declaration.location.line === 0 ? sourceLines(source) : sites.reduce((total, site) => total + site.span.lines, 0);
    rendered.push({ element: 'symbol', attributes: { at: declaration.address, name: declaration.name, kind: declaration.kind, lines }, text });
  }
  const limit = invocation.input.flags['--limit'] as number | undefined;
  const shown = limit === undefined ? rendered : rendered.slice(0, limit);
  const capped = shown.length < rendered.length;
  return {
    data: { element: 'show', attributes: { count: rendered.length, shown: capped ? shown.length : undefined }, children: shown },
    count: rendered.length,
    receipt: capped ? `${shown.length} of ${rendered.length} show rows shown, limit ${limit}, ${Math.round(performance.now() - started)} ms` : `${shown.length} show declaration${shown.length === 1 ? '' : 's'}, ${Math.round(performance.now() - started)} ms`,
  };
};

function storedSpan(context: Parameters<SemanticHandler>[0], declaration: DeclarationRecord): StoredSpan {
  if (!context.store) throw new DeclarationError('not-in-program', 'The TypeScript index is not available yet.');
  const row = query(context.store, 'MATCH (d:Declaration) WHERE d.file = $file AND d.line = $line AND d.col = $col RETURN d.endLine AS endLine, d.lines AS lines, d.declCount AS declCount', { file: declaration.location.path, line: declaration.location.line, col: declaration.location.col })[0];
  if (!row) throw new DeclarationError('unresolvable-symbol', `${declaration.address} is absent from the TypeScript index`);
  return { endLine: Number(row.endLine), lines: Number(row.lines), declCount: Number(row.declCount) };
}

async function declarationSites(context: Parameters<SemanticHandler>[0], declaration: DeclarationRecord, stored: StoredSpan): Promise<Array<{ source: string; span: StoredSpan }>> {
  if (stored.declCount === 1) return [{ source: context.source.read(declaration.file), span: stored }];
  const membership = await context.projects.membership(declaration.file);
  if (!membership) throw new DeclarationError('not-in-program', `${declaration.location.path} exists but is not part of a TypeScript project under ${context.root}`);
  const sites = context.program.withSnapshot((snapshot) => {
    const project = snapshot.getProject(membership.config);
    if (!project) throw new Error(`TypeScript project ${membership.config} is not loaded.`);
    const symbol = project.checker.getSymbolAtPosition(declaration.file, declaration.nameSpan.start);
    return (symbol?.declarations ?? []).flatMap((handle) => {
      const node = handle.resolve(project);
      if (!node) return [];
      const source = node.getSourceFile();
      const start = source.getLineAndCharacterOfPosition(node.getStart(source));
      const end = source.getLineAndCharacterOfPosition(node.getEnd());
      return [{ source: context.source.read(source.fileName), span: { endLine: end.line + 1, lines: end.line - start.line + 1, declCount: stored.declCount } }];
    });
  });
  if (sites.length === 0) throw new DeclarationError('unresolvable-symbol', `${declaration.address} has no declaration sites in the TypeScript program`);
  return sites;
}

function declarationText(source: string, span: StoredSpan): string {
  const firstLine = span.endLine - span.lines + 1;
  return source.split('\n').slice(firstLine - 1, span.endLine).join('\n');
}

function sourceLines(source: string): number { return source.split('\n').length - (source.endsWith('\n') ? 1 : 0); }

export default handler;
