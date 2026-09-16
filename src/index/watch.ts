import { existsSync, statSync, watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { discoverDirectories, type ConfiguredProjects } from '../ts7/projects.js';

export interface WatchBatch {
  fileChanges: { changed?: string[]; created?: string[]; deleted?: string[] } | { invalidateAll: true };
  full: boolean;
}

export interface IndexWatcher {
  close(): void;
  refresh(): void;
}

type FileEvent = 'changed' | 'created' | 'deleted';

/** Watches configured source directories; events supply text changes, never semantic invalidation. */
export function watchIndex(root: string, projects: ConfiguredProjects, refresh: (batch: WatchBatch) => Promise<void>, reportError: (error: unknown) => void, markStale: (flush: () => Promise<void>) => void): IndexWatcher {
  let knownFiles = new Set<string>();
  let watchers: FSWatcher[] = [];
  let timer: NodeJS.Timeout | undefined;
  let firstEventAt: number | undefined;
  let invalidated = false;
  let full = false;
  const events = new Map<string, FileEvent>();
  let chain = Promise.resolve();
  const debounceMs = configuredDebounceMs();

  const resetDirectories = () => {
    for (const watcher of watchers) watcher.close();
    const sourceFiles = projects.records().flatMap((project) => [...project.files]);
    const configs = projects.records().map((project) => project.config);
    // Configs are known files: rewriting one is a change, and calling it a creation leaves TypeScript on the stale config.
    knownFiles = new Set([...sourceFiles, ...configs]);
    // Every workspace directory is watched, not only those holding a known file: fs.watch is not recursive, so a
    // directory that is empty today reports nothing when the first file appears in it.
    watchers = discoverDirectories(root).map((directory) => watch(directory, (_event, name) => {
      if (name === null) { invalidate(); return; }
      const file = path.resolve(directory, name.toString());
      const relative = path.relative(root, file);
      if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
      // fs.watch reports renames for a directory move and does not enumerate every moved child.
      if (isDirectory(file) || [...knownFiles].some((known) => known.startsWith(`${file}${path.sep}`))) { invalidate(); return; }
      const configuration = path.basename(file) === 'tsconfig.json' || path.basename(file) === 'package.json';
      const known = knownFiles.has(file);
      // A membership change needs the full path, which resets knownFiles from the reloaded project records.
      if (existsSync(file)) record(file, known ? 'changed' : 'created', configuration || !known);
      else record(file, 'deleted', configuration || known);
    }));
  };

  function record(file: string, event: FileEvent, requiresFull: boolean): void {
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
    };
    invalidated = false;
    full = false;
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
  return {
    close() {
      if (timer) clearTimeout(timer);
      for (const watcher of watchers) watcher.close();
    },
    refresh: resetDirectories,
  };
}

function isDirectory(file: string): boolean {
  try { return statSync(file).isDirectory(); }
  catch { return false; }
}

function configuredDebounceMs(): number {
  const value = process.env.TSYM_DEBOUNCE_MS;
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : 300;
}
