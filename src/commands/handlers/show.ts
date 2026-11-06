import { DeclarationError, type DeclarationRecord } from '../../core/declarations.js';
import { describeFile } from '../../index/descriptor.js';
import { isIndexedDeclaration } from '../../index/scope.js';
import { query } from '../../store/query.js';
import type { SemanticHandler } from '../handlers.js';

/** One declaration site: its line boundaries and the source text they were measured in, always from the same read. */
interface Site { file: string; source: string; firstLine: number; endLine: number; }
interface StoredIdentity { key: string; declCount: number; }

const handler: SemanticHandler = async (context, invocation) => {
  await context.projects.bootstrap();
  const started = performance.now();
  const resolved = await context.resolver.resolveAll(invocation.input.args);
  const rendered: Array<{ node: { element: string; attributes: { at: string; name: string; kind: string; lines: number }; text: string }; files: string[] }> = [];
  for (const declaration of resolved) {
    if (declaration.location.line === 0) {
      const source = context.source.read(declaration.file);
      rendered.push({ node: { element: 'symbol', attributes: { at: declaration.address, name: declaration.name, kind: declaration.kind, lines: sourceLines(source) }, text: source }, files: [declaration.file] });
      continue;
    }
    const { at, sites } = await declarationSites(context, declaration, storedIdentity(context, declaration));
    const text = sites.map(siteText).join('\n');
    const lines = sites.reduce((total, site) => total + site.endLine - site.firstLine + 1, 0);
    rendered.push({ node: { element: 'symbol', attributes: { at, name: declaration.name, kind: declaration.kind, lines }, text }, files: [...new Set(sites.map((site) => site.file))] });
  }
  const limit = invocation.input.flags['--limit'] as number | undefined;
  const shown = limit === undefined ? rendered : rendered.slice(0, limit);
  const capped = shown.length < rendered.length;
  return {
    data: { element: 'show', attributes: { count: rendered.length, shown: capped ? shown.length : undefined }, children: shown.map((item) => item.node) },
    count: rendered.length,
    displayedFiles: [...new Set(shown.flatMap((item) => item.files))],
    receipt: capped ? `${shown.length} of ${rendered.length} show rows shown, limit ${limit}, ${Math.round(performance.now() - started)} ms` : `${shown.length} show declaration${shown.length === 1 ? '' : 's'}, ${Math.round(performance.now() - started)} ms`,
  };
};

/** The index names the declaration (its key) and how many sites it has; it never supplies the boundaries that are printed. */
function storedIdentity(context: Parameters<SemanticHandler>[0], declaration: DeclarationRecord): StoredIdentity {
  if (!context.store) throw new DeclarationError('not-in-program', 'The TypeScript index is not available yet.');
  const row = query(context.store, 'MATCH (d:Declaration) WHERE d.file = $file AND d.line = $line AND d.col = $col RETURN d.key AS key, d.declCount AS declCount', { file: declaration.location.path, line: declaration.location.line, col: declaration.location.col })[0];
  if (!row) throw new DeclarationError('unresolvable-symbol', `${declaration.address} is absent from the TypeScript index`);
  return { key: String(row.key), declCount: Number(row.declCount) };
}

/**
 * Locates the declaration by its index key in one read of the current file and measures its boundaries in that same
 * text, so the printed lines always belong to the named declaration even when the index is older than the file.
 */
async function declarationSites(context: Parameters<SemanticHandler>[0], declaration: DeclarationRecord, stored: StoredIdentity): Promise<{ at: string; sites: Site[] }> {
  const source = context.source.read(declaration.file);
  const current = describeFile(declaration.location.path, source).filter((descriptor) => descriptor.key === stored.key && isIndexedDeclaration(descriptor));
  if (current.length === 0) throw new DeclarationError('unresolvable-symbol', `${declaration.address} names ${stored.key.slice(stored.key.indexOf('#') + 1)}, which the index recorded but ${declaration.location.path} no longer declares; the file changed after the index was built. Run find or outline for its current address.`);
  const at = addressOf(declaration.location.path, source, current[0]!.nameStart);
  if (stored.declCount === 1 && current.length === 1) return { at, sites: [siteIn(declaration.file, source, current[0]!.start, current[0]!.end)] };
  return { at, sites: await mergedSites(context, declaration, stored.key) };
}

/**
 * Overloads and merged declarations come from the checker. The name position, the declaration sites and the text each
 * site is sliced from all come from one TypeScript snapshot, so they agree even if the file changes during the call.
 */
async function mergedSites(context: Parameters<SemanticHandler>[0], declaration: DeclarationRecord, key: string): Promise<Site[]> {
  const membership = await context.projects.membership(declaration.file);
  if (!membership) throw new DeclarationError('not-in-program', `${declaration.location.path} exists but is not part of a TypeScript project under ${context.root}`);
  context.projects.refreshFile(declaration.file);
  const sites = context.program.withSnapshot((snapshot) => {
    const project = snapshot.getProject(membership.config);
    if (!project) throw new Error(`TypeScript project ${membership.config} is not loaded.`);
    const file = project.program.getSourceFile(declaration.file);
    const named = file && describeFile(declaration.location.path, file.text).find((descriptor) => descriptor.key === key);
    if (!named) return [];
    const symbol = project.checker.getSymbolAtPosition(declaration.file, named.nameStart);
    return (symbol?.declarations ?? []).flatMap((handle) => {
      const node = handle.resolve(project);
      if (!node) return [];
      const source = node.getSourceFile();
      return [siteIn(source.fileName, source.text, node.getStart(source), node.getEnd())];
    });
  });
  if (sites.length === 0) throw new DeclarationError('unresolvable-symbol', `${declaration.address} has no declaration sites in the TypeScript program`);
  return sites;
}

function siteIn(file: string, source: string, start: number, end: number): Site {
  return { file, source, firstLine: lineAt(source, start), endLine: lineAt(source, end) };
}

function siteText(site: Site): string {
  return site.source.split('\n').slice(site.firstLine - 1, site.endLine).join('\n');
}

function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1)) line++;
  return line;
}

function addressOf(file: string, source: string, offset: number): string {
  const line = lineAt(source, offset);
  return `${file}:${line}:${offset - (source.lastIndexOf('\n', offset - 1) + 1) + 1}`;
}

function sourceLines(source: string): number { return source.split('\n').length - (source.endsWith('\n') ? 1 : 0); }

export default handler;
