import { escapeText } from '../../output.js';
import { displayPath, navto, normalKind } from '../../read/read.js';
import { matchesPathFilters } from '../../core/receipt.js';
import type { SemanticHandler } from '../handlers.js';

const handler: SemanticHandler = async (context, invocation) => {
  await context.projects.bootstrap();
  const started = performance.now();
  const name = invocation.input.args[0]!;
  const flags = invocation.input.flags;
  const prefix = flags['--prefix'] === true;
  const qualified = name.includes('.');
  const candidates = await navto(context, name);
  const rows = new Map<string, { address: string; path: string; kind: string; exported: boolean; qualifiedName: string }>();
  for (const candidate of candidates) {
    const candidateName = qualified ? `${candidate.containerName ?? ''}.${candidate.name}` : candidate.name;
    if (prefix ? !candidateName.startsWith(name) : candidateName !== name) continue;
    const kind = normalKind(candidate.kind);
    const kinds = flags['--kind'] as string[] | undefined;
    const relative = displayPath(context.root, candidate.file);
    if ((kinds && !kinds.includes(kind)) || !matchesPathFilters(relative, { in: flags['--in'] as string[] | undefined, exclude: flags['--exclude'] as string[] | undefined })) continue;
    const declaration = await context.resolver.fromFileSpan(candidate);
    const sourceLine = context.source.read(candidate.file).split('\n')[candidate.start.line - 1] ?? '';
    rows.set(declaration.address, { address: declaration.address, path: relative, kind, exported: candidate.kindModifiers.split(/[\s,]+/).includes('export') || /\bexport\b/.test(sourceLine), qualifiedName: declaration.qualifiedName });
  }
  const limit = flags['--limit'] as number | undefined;
  const sorted = [...rows.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || numericAddress(a.address, b.address));
  const shown = limit === undefined ? sorted : sorted.slice(0, limit);
  return {
    element: 'find',
    attributes: { name, count: shown.length },
    body: shown.map((row) => `${row.address}  ${row.kind}${row.exported ? '  export' : ''}  ${escapeText(row.qualifiedName)}`).join('\n'),
    count: shown.length,
    receipt: `${shown.length} find row${shown.length === 1 ? '' : 's'}${limit !== undefined && sorted.length > shown.length ? `, limit ${limit}` : ''}, ${Math.round(performance.now() - started)} ms`,
  };
};

function numericAddress(a: string, b: string): number {
  const [aLine, aColumn] = a.split(':').slice(-2).map(Number);
  const [bLine, bColumn] = b.split(':').slice(-2).map(Number);
  return aLine! - bLine! || aColumn! - bColumn!;
}

export default handler;
