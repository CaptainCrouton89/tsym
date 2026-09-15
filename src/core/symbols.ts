import { existsSync } from 'node:fs';
import { find } from './find.js';
import { outline } from './outline.js';
import type { Symbol } from './types.js';
import type { Workspace } from './workspace.js';

/** A symbol address as the CLI accepts it. */
export type Address = { kind: 'position'; path: string; line: number; col: number | null } | { kind: 'name'; name: string };

export class SymbolNotFound extends Error {
  constructor(address: string) {
    super(`no symbol matches ${address}`);
  }
}

export class AmbiguousSymbol extends Error {
  readonly candidates: Symbol[];
  constructor(address: string, candidates: Symbol[]) {
    super(`${address} matches ${candidates.length} declarations; pick one with --path FILE or use its address:\n` + candidates.map((c) => `  ${formatAddress(c)}  ${c.kind} ${c.qualifiedName}`).join('\n'));
    this.candidates = candidates;
  }
}

export function formatAddress(s: Symbol): string {
  return `${s.path}:${s.namePos.line}:${s.namePos.col}`;
}

export function parseAddress(ws: Workspace, raw: string): Address {
  const m = /^(.+?):(\d+)(?::(\d+))?$/.exec(raw);
  if (m && existsSync(ws.abs(m[1]!))) {
    return { kind: 'position', path: ws.rel(ws.abs(m[1]!)), line: Number(m[2]), col: m[3] ? Number(m[3]) : null };
  }
  return { kind: 'name', name: raw };
}

export interface ResolveOptions {
  /** Restrict a name lookup to one file. */
  path?: string;
}

/** Resolve an address to exactly one declaration, or throw SymbolNotFound / AmbiguousSymbol. */
export async function resolveSymbol(ws: Workspace, raw: string, opts: ResolveOptions = {}): Promise<Symbol> {
  const address = parseAddress(ws, raw);
  if (address.kind === 'position') {
    const syms = outline(ws, address.path).items;
    const atName = syms.filter((s) => s.namePos.line === address.line && (address.col === null || (address.col >= s.namePos.col && address.col <= s.namePos.col + s.name.length)));
    if (atName.length > 0) return atName[0]!;
    // Innermost declaration whose range contains the line.
    const containing = syms.filter((s) => s.start.line <= address.line && address.line <= s.end.line);
    if (containing.length === 0) throw new SymbolNotFound(raw);
    return containing.reduce((best, s) => (s.end.line - s.start.line < best.end.line - best.start.line ? s : best));
  }
  const inFile = opts.path ? ws.rel(ws.abs(opts.path)) : undefined;
  const found = (await find(ws, address.name, { in: inFile })).items;
  if (found.length === 0) throw new SymbolNotFound(raw);
  if (found.length === 1) return found[0]!;
  // A bare name that matches one top-level declaration plus same-named members: prefer the top-level one.
  const topLevel = found.filter((s) => s.qualifiedName === s.name);
  if (topLevel.length === 1) return topLevel[0]!;
  throw new AmbiguousSymbol(raw, found);
}
