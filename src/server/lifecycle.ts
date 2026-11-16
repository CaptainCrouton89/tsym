import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import path from 'node:path';

export interface ServerPaths { root: string; state: string; lock: string; port: string; pid: string; log: string; store: string; results: string; }
export interface PublishedState { root: string; pid: number; bootedAt: string; port: string; log: string; idleDeadline: string; state: 'ready' | 'stopping'; index?: 'current' | 'stale'; declarations?: number; }

/** The nearest ancestor of `start` holding a tsconfig.json, else package.json, else .git; undefined when none does. */
export function findProjectRoot(start: string): string | undefined {
  for (const marker of ['tsconfig.json', 'package.json', '.git']) {
    let candidate = path.resolve(start);
    for (;;) {
      if (existsSync(path.join(candidate, marker))) return realpathSync(candidate);
      const parent = path.dirname(candidate);
      if (parent === candidate) break;
      candidate = parent;
    }
  }
  return undefined;
}

export function discoverRoot(input: string | undefined, cwd = process.cwd()): string {
  const start = path.resolve(input ?? cwd);
  return findProjectRoot(start) ?? realpathSync(start);
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

/** Records that a query reached this root's resident; the expiry sweep reads its modification time. */
export function markUsed(paths: ServerPaths): void {
  writeFileSync(path.join(paths.state, 'used'), '', { mode: 0o600 });
}

export function cacheExpiryMs(): number {
  const configured = process.env.TSYM_CACHE_EXPIRY_DAYS;
  return (configured !== undefined && /^[1-9]\d*$/.test(configured) ? Number(configured) : 7) * 86_400_000;
}

/** Removes sibling caches whose root has not been queried within the expiry and whose resident is not running. Returns the removed directories. */
export function sweepExpiredCaches(own: ServerPaths, now = Date.now()): string[] {
  const base = path.dirname(own.state);
  const removed: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(base, entry.name);
    if (directory === own.state) continue;
    try {
      const pid = readState({ pid: path.join(directory, 'pid') } as ServerPaths)?.pid;
      if (pid !== undefined && processAlive(pid)) continue;
      const stamps = ['used', 'pid', 'log', 'store/meta.json'].flatMap((name) => { try { return [statSync(path.join(directory, name)).mtimeMs]; } catch { return []; } });
      const last = stamps.length > 0 ? Math.max(...stamps) : statSync(directory).mtimeMs;
      if (now - last < cacheExpiryMs()) continue;
      rmSync(directory, { recursive: true, force: true });
      removed.push(directory);
    } catch {}
  }
  return removed;
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error: unknown) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function removeEndpoint(paths: ServerPaths): void {
  for (const entry of [paths.port, paths.pid]) {
    try { rmSync(entry); } catch (error: unknown) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}

export function idleSeconds(): number {
  const configured = process.env.TSYM_IDLE_SECONDS;
  if (configured !== undefined && /^\d+$/.test(configured)) return Number(configured);
  return 1_200;
}

export function maxResidents(): number {
  const configured = process.env.TSYM_MAX_RESIDENTS;
  const parsed = configured !== undefined && /^[1-9]\d*$/.test(configured) ? Number(configured) : undefined;
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : 3;
}
