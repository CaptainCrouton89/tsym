import { execFileSync } from 'node:child_process';
import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { discoverDirectories, isProgramFileCandidate, skippedDirectories, type ConfiguredProjects } from '../ts7/projects.js';

export interface WatchBatch {
  fileChanges: { changed?: string[]; created?: string[]; deleted?: string[] } | { invalidateAll: true };
  full: boolean;
  git: boolean;
}

export interface IndexWatcher {
  close(): void;
  refresh(): void;
}

type FileEvent = 'changed' | 'created' | 'deleted';

/** Watches configured source directories; events supply text changes, never semantic invalidation. */
export function watchIndex(root: string, projects: ConfiguredProjects, refresh: (batch: WatchBatch) => Promise<void>, reportError: (error: unknown) => void, markStale: (flush: () => Promise<void>) => void): IndexWatcher {
  let knownFiles = new Set<string>();
  let knownDirectories = new Set<string>();
  let rootWatcher: FSWatcher | undefined;
  let gitWatcher: { close(): void } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let firstEventAt: number | undefined;
  let invalidated = false;
  let full = false;
  let git = false;
  const events = new Map<string, FileEvent>();
  let chain = Promise.resolve();
  const debounceMs = configuredDebounceMs();

  const resetDirectories = () => {
    gitWatcher?.close();
    const sourceFiles = projects.records().flatMap((project) => [...project.files]);
    const configs = projects.records().map((project) => project.config);
    // Configs are known files: rewriting one is a change, and calling it a creation leaves TypeScript on the stale config.
    knownFiles = new Set([...sourceFiles, ...configs]);
    knownDirectories = new Set(discoverDirectories(root));
    gitWatcher = watchGit(root, () => { git = true; invalidate(); });
  };

  const onRootEvent = (_event: string, name: string | Buffer | null) => {
    if (name === null) { invalidate(); return; }
    const file = path.resolve(root, name.toString());
    const relative = path.relative(root, file);
    if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative.split(path.sep).some((part) => skippedDirectories.has(part))) return;
    // fs.watch reports renames for a directory move and does not enumerate every moved child.
    if (isDirectory(file) || knownDirectories.has(file) || [...knownFiles].some((known) => known.startsWith(`${file}${path.sep}`))) { invalidate(); return; }
    const known = knownFiles.has(file);
    if (!known && !isProgramFileCandidate(file)) return;
    const configuration = path.basename(file) === 'tsconfig.json' || path.basename(file) === 'package.json';
    // A membership change needs the full path, which resets knownFiles from the reloaded project records.
    if (existsSync(file)) record(file, known ? 'changed' : 'created', configuration || !known);
    else record(file, 'deleted', configuration || known);
  };

  function record(file: string, event: FileEvent, requiresFull: boolean): void {
    if (event === 'created') knownFiles.add(file);
    events.set(file, event);
    schedule(requiresFull);
  }

  function invalidate(): void {
    invalidated = true;
    schedule(true);
  }

  /** Marks the index stale on a batch's first event and debounces the flush that clears it. */
  function schedule(requiresFull: boolean): void {
    full ||= requiresFull;
    const now = Date.now();
    if (firstEventAt === undefined) markStale(flush);
    firstEventAt ??= now;
    if (timer) clearTimeout(timer);
    const cap = Math.max(0, 5_000 - (now - firstEventAt));
    timer = setTimeout(() => { void flush(); }, Math.min(debounceMs, cap));
    timer.unref();
  }

  /** Refreshes whatever has accumulated and resolves when every batch queued so far has been applied. */
  function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (!invalidated && events.size === 0) return chain;
    const batch: WatchBatch = {
      fileChanges: invalidated ? { invalidateAll: true } : { changed: files('changed'), created: files('created'), deleted: files('deleted') },
      full,
      git,
    };
    invalidated = false;
    full = false;
    git = false;
    events.clear();
    firstEventAt = undefined;
    chain = chain.then(() => refresh(batch), () => refresh(batch));
    void chain.catch(reportError);
    return chain;
  }

  function files(event: FileEvent): string[] {
    return [...events].filter(([, recorded]) => recorded === event).map(([file]) => file);
  }

  resetDirectories();
  rootWatcher = watch(root, { recursive: true }, onRootEvent);
  return {
    close() {
      if (timer) clearTimeout(timer);
      rootWatcher?.close();
      gitWatcher?.close();
    },
    refresh: resetDirectories,
  };
}

function isDirectory(file: string): boolean {
  try { return statSync(file).isDirectory(); }
  catch { return false; }
}

function watchGit(root: string, changed: () => void): { close(): void } {
  let state = gitState(root);
  const gitDir = gitPath(root, '--git-dir');
  const commonDir = gitPath(root, '--git-common-dir');
  let watchers: FSWatcher[] = [];
  const bind = () => {
    for (const watcher of watchers) watcher.close();
    const paths = new Set([
      gitDir === undefined ? undefined : path.join(gitDir, 'HEAD'),
      commonDir === undefined ? undefined : path.join(commonDir, 'packed-refs'),
      commonDir === undefined ? undefined : path.join(commonDir, 'refs', 'heads'),
      commonDir === undefined || state.ref === undefined ? undefined : path.dirname(path.join(commonDir, state.ref)),
      commonDir === undefined || state.ref === undefined ? undefined : path.join(commonDir, state.ref),
    ].filter((target): target is string => target !== undefined));
    watchers = [];
    for (const target of paths) {
      if (!existsSync(target)) continue;
      try { watchers.push(watch(target, check)); }
      catch { /* A ref can disappear while its branch changes; the remaining watcher reconnects when HEAD moves. */ }
    }
  };
  const check = () => {
    const next = gitState(root);
    if (next.head === state.head && next.ref === state.ref) return;
    state = next;
    bind();
    changed();
  };
  bind();
  return { close: () => { for (const watcher of watchers) watcher.close(); } };
}

function gitState(root: string): { head: string | undefined; ref: string | undefined } {
  return { head: gitOutput(root, ['rev-parse', 'HEAD']), ref: gitOutput(root, ['symbolic-ref', '-q', 'HEAD']) };
}

function gitPath(root: string, value: '--git-dir' | '--git-common-dir'): string | undefined {
  const output = gitOutput(root, ['rev-parse', value]);
  return output === undefined ? undefined : path.resolve(root, output);
}

function gitOutput(root: string, args: string[]): string | undefined {
  try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return undefined; }
}

function configuredDebounceMs(): number {
  const value = process.env.TSYM_DEBOUNCE_MS;
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : 300;
}
