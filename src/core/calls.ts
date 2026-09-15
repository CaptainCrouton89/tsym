import { calleesOf } from './callees.js';
import { finish } from './receipt.js';
import { resolveSymbol, type ResolveOptions } from './symbols.js';
import { declarationForSymbol } from './ts-program.js';
import type { Callee, Result } from './types.js';
import type { Workspace } from './workspace.js';

export interface CallsOptions extends ResolveOptions {
  limit?: number | null;
}

/** Direct callees of a function, method, or constructor. */
export async function calls(ws: Workspace, address: string, opts: CallsOptions = {}): Promise<Result<Callee>> {
  const startedAt = performance.now();
  const symbol = await resolveSymbol(ws, address, opts);
  const result = calleesOf(ws, declarationForSymbol(ws, symbol), 1);
  const items = result.items.map(({ declaration: _declaration, callable: _callable, ...callee }) => callee);
  return finish({ command: 'calls', query: address, root: ws.root, engine: 'ts-morph', filesScanned: ws.projectFor(symbol.path).getSourceFiles().length, startedAt, limit: opts.limit, unresolved: result.unresolved.length }, items);
}
