import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export interface ServerPaths { root: string; state: string; lock: string; port: string; pid: string; log: string; store: string; results: string; }
export interface PublishedState { root: string; pid: number; bootedAt: string; port: string; log: string; idleDeadline: string; state: 'ready' | 'stopping'; index?: 'current' | 'stale'; declarations?: number; }

export function discoverRoot(input: string | undefined, cwd = process.cwd()): string {
  let current = path.resolve(input ?? cwd);
  for (const marker of ['tsconfig.json', 'package.json', '.git']) {
    let candidate = current;
    for (;;) {
      if (existsSync(path.join(candidate, marker))) return realpathSync(candidate);
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return realpathSync(current);
}

export function pathsForRoot(root: string): ServerPaths {
  const stateBase = process.env.XDG_CACHE_HOME ?? path.join(process.env.HOME ?? '~', '.cache');
  const id = createHash('sha256').update(root).digest('hex').slice(0, 16);
  const state = path.join(stateBase, 'tsym', id);
  return { root, state, lock: path.join(state, 'lock'), port: path.join(state, 'port'), pid: path.join(state, 'pid'), log: path.join(state, 'log'), store: path.join(state, 'store'), results: path.join(state, 'results') };
}

export function ensureStateDirectory(paths: ServerPaths): void {
  mkdirSync(paths.state, { recursive: true, mode: 0o700 });
  chmodSync(paths.state, 0o700);
  for (const directory of [paths.store, paths.results]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
}

export function readState(paths: ServerPaths): PublishedState | null {
  try { return JSON.parse(readFileSync(paths.pid, 'utf8')) as PublishedState; } catch { return null; }
}

export function publishState(paths: ServerPaths, state: PublishedState): void {
  writeFileSync(paths.pid, JSON.stringify(state) + '\n', { mode: 0o600 });
  chmodSync(paths.pid, 0o600);
}

export function removeEndpoint(paths: ServerPaths): void {
  for (const entry of [paths.port, paths.pid]) {
    try { rmSync(entry); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function idleSeconds(): number {
  const configured = process.env.TSYM_IDLE_SECONDS;
  if (configured !== undefined && /^\d+$/.test(configured)) return Number(configured);
  return 900;
}
