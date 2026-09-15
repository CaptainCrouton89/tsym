import { finish, type PathFilters } from './receipt.js';
import { resolveSymbol, type ResolveOptions } from './symbols.js';
import type { Excerpt, Result } from './types.js';
import type { Workspace } from './workspace.js';

export interface ShowOptions extends ResolveOptions, PathFilters {}

/** Source text of one declaration, with the doc comment directly above it. */
export async function show(ws: Workspace, address: string, opts: ShowOptions = {}): Promise<Result<Excerpt>> {
  const startedAt = performance.now();
  const symbol = await resolveSymbol(ws, address, opts);
  const lines = ws.read(symbol.path).split('\n');
  const startLine = docCommentStart(lines, symbol.start.line);
  const source = lines.slice(startLine - 1, symbol.end.line).join('\n');
  const item: Excerpt = { path: symbol.path, start: { line: startLine, col: 1 }, end: symbol.end, symbol, source };
  return finish({ command: 'show', query: address, root: ws.root, engine: 'ast-grep', filesScanned: 1, startedAt, ...opts }, [item]);
}

/** Line number where the comment block attached to `declLine` starts, or `declLine` itself. */
function docCommentStart(lines: string[], declLine: number): number {
  let i = declLine - 1; // index of the line above the declaration
  const above = lines[i - 1]?.trim();
  if (above === undefined) return declLine;
  if (above.endsWith('*/')) {
    let j = i - 1;
    while (j >= 0 && !lines[j]!.trim().startsWith('/*')) j--;
    return j >= 0 ? j + 1 : declLine;
  }
  if (above.startsWith('//')) {
    let j = i - 1;
    while (j - 1 >= 0 && lines[j - 1]!.trim().startsWith('//')) j--;
    return j + 1;
  }
  return declLine;
}
