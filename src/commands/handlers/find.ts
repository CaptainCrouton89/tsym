import { displayPath, navto, navtree, normalKind, readSymbols, type ReadSymbol } from '../../read/read.js';
import { matchesPathFilters } from '../../core/receipt.js';
import type { SemanticHandler } from '../handlers.js';

const handler: SemanticHandler = async (context, invocation) => {
  await context.projects.bootstrap();
  const started = performance.now();
  const name = invocation.input.args[0]!;
  const flags = invocation.input.flags;
  const prefix = flags['--prefix'] === true;
  const qualified = name.includes('.');
  const candidates = await navto(context, qualified ? name.slice(name.lastIndexOf('.') + 1) : name);
  const rows = new Map<string, { address: string; path: string; kind: string; exported: boolean; qualifiedName: string }>();
  const qualifiedNames = new Map<string, Map<string, string>>();
  for (const candidate of candidates) {
    const candidateName = candidate.name;
    if (prefix ? !candidateName.startsWith(qualified ? name.slice(name.lastIndexOf('.') + 1) : name) : candidateName !== (qualified ? name.slice(name.lastIndexOf('.') + 1) : name)) continue;
    const kind = normalKind(candidate.kind);
    const kinds = flags['--kind'] as string[] | undefined;
    const relative = displayPath(context.root, candidate.file);
    if ((kinds && !kinds.includes(kind)) || !matchesPathFilters(relative, { in: flags['--in'] as string[] | undefined, exclude: flags['--exclude'] as string[] | undefined })) continue;
    const declaration = await context.resolver.fromFileSpan(candidate);
    const source = context.source.read(candidate.file);
    let names = qualifiedNames.get(candidate.file);
    if (!names) {
      names = new Map();
      const add = (symbol: ReadSymbol) => { names!.set(symbol.address, symbol.qualifiedName); symbol.children.forEach(add); };
      for (const symbol of readSymbols(context.root, candidate.file, await navtree(context, candidate.file), source)) add(symbol);
      qualifiedNames.set(candidate.file, names);
    }
    const qualifiedName = names.get(declaration.address) ?? declaration.qualifiedName;
    if (qualified && !(prefix ? qualifiedName.startsWith(name) : qualifiedName === name)) continue;
    const sourceLine = source.split('\n')[candidate.start.line - 1] ?? '';
    rows.set(declaration.address, { address: declaration.address, path: relative, kind, exported: candidate.kindModifiers.split(/[\s,]+/).includes('export') || /\bexport\b/.test(sourceLine), qualifiedName });
  }
  const limit = flags['--limit'] as number | undefined;
  const sorted = [...rows.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || numericAddress(a.address, b.address));
  const shown = limit === undefined ? sorted : sorted.slice(0, limit);
  const capped = shown.length < sorted.length;
  return {
    data: { element: 'find', attributes: { name, count: sorted.length, shown: capped ? shown.length : undefined }, text: shown.map((row) => `${row.address}  ${row.kind}${row.exported ? '  export' : ''}  ${row.qualifiedName}`).join('\n') },
    count: sorted.length,
    receipt: capped
      ? `${shown.length} of ${sorted.length} find rows shown, limit ${limit}, ${Math.round(performance.now() - started)} ms`
      : `${shown.length} find row${shown.length === 1 ? '' : 's'}, ${Math.round(performance.now() - started)} ms`,
  };
};

function numericAddress(a: string, b: string): number {
  const [aLine, aColumn] = a.split(':').slice(-2).map(Number);
  const [bLine, bColumn] = b.split(':').slice(-2).map(Number);
  return aLine! - bLine! || aColumn! - bColumn!;
}

export default handler;
