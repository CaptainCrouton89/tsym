import { calleesOf } from './callees.js';
import { finish, type PathFilters } from './receipt.js';
import { asAddresses, resolveSymbol, uniqueSymbols, type ResolveOptions } from './symbols.js';
import { declarationForSymbol } from './ts-program.js';
import type { Callee, Result } from './types.js';
import type { Workspace } from './workspace.js';
import { projectFor } from './legacy-projects.js';

export interface CallsOptions extends ResolveOptions, PathFilters {
  limit?: number | null;
}

/** Direct callees of one or more functions, methods, or constructors. */
export async function calls(ws: Workspace, addresses: string | readonly string[], opts: CallsOptions = {}): Promise<Result<Callee>> {
  const startedAt = performance.now();
  const inputs = asAddresses(addresses);
  const symbols = uniqueSymbols(await Promise.all(inputs.map((address) => resolveSymbol(ws, address, opts))));
  const byKey = new Map<string, Callee>();
  let unresolved = 0;
  for (const symbol of symbols) {
    const result = calleesOf(ws, declarationForSymbol(ws, symbol), 1);
    unresolved += result.unresolved.length;
    for (const { declaration: _declaration, callable: _callable, ...callee } of result.items) {
      const existing = byKey.get(key(callee));
      if (existing) existing.callSites += callee.callSites;
      else byKey.set(key(callee), callee);
    }
  }
  const items = [...byKey.values()].sort(compareCallees);
  return finish({ command: 'calls', query: inputs.join(' '), root: ws.root, engine: 'ts-morph', filesScanned: Math.max(...symbols.map((symbol) => projectFor(ws, symbol.path).getSourceFiles().length)), startedAt, limit: opts.limit, unresolved, ...opts }, items);
}

function key(loc: { path: string; start: { line: number; col: number } }): string {
  return `${loc.path}:${loc.start.line}:${loc.start.col}`;
}

function compareCallees(a: Callee, b: Callee): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : a.start.line - b.start.line || a.start.col - b.start.col;
}
