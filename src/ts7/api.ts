import { readFileSync } from 'node:fs';
import path from 'node:path';
import { API, type Project, type Snapshot } from 'typescript/unstable/sync';
import { resolveFileName } from 'typescript/unstable/proto';
import type { UpdateSnapshotParams } from 'typescript/unstable/proto';

export class Ts7ServerDiedError extends Error {
  constructor(cause: unknown) {
    super('The bundled TypeScript 7 API stopped responding.', { cause });
  }
}

/** Owns the one TypeScript 7 API client and its current snapshot for a resident. */
export class Ts7Host {
  private api: API;
  private snapshot: Snapshot | undefined;
  private configs: readonly string[] = [];
  /** Paths named by the most recent update; only these are read from disk, so unchanged files keep the server's native reads. */
  private changed = new Set<string>();

  constructor(readonly root: string) { this.api = this.createApi(); }

  /** Opens newly discovered configs and closes vanished ones; project opens are ref-counted, so each open needs its close. */
  load(configs: readonly string[]): readonly Project[] {
    const open = new Set(this.configs);
    const next = new Set(configs);
    const openProjects = configs.filter((config) => !open.has(config));
    const closeProjects = this.configs.filter((config) => !next.has(config));
    this.configs = [...configs];
    return this.replaceSnapshot({ openProjects, closeProjects }).getProjects();
  }

  update(params: UpdateSnapshotParams): readonly Project[] {
    this.changed = params.fileChanges && !('invalidateAll' in params.fileChanges)
      ? new Set([...params.fileChanges.changed ?? [], ...params.fileChanges.created ?? [], ...params.fileChanges.deleted ?? []].map((file) => path.resolve(resolveFileName(file))))
      : new Set();
    return this.replaceSnapshot(params).getProjects();
  }

  withSnapshot<T>(operation: (snapshot: Snapshot) => T): T {
    return this.request(() => operation(this.requireSnapshot()));
  }

  sourceFile(config: string | undefined, file: string) {
    const source = this.withSnapshot((snapshot) => config ? snapshot.getProject(config)?.program.getSourceFile(file) : snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file));
    if (source || config) return source;
    this.replaceSnapshot({ openFiles: [file] });
    return this.withSnapshot((snapshot) => snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file));
  }

  close(): void {
    this.disposeSnapshot();
    try { this.api.close(); }
    catch (error) { if (!isBadFileDescriptor(error)) throw error; }
  }

  private replaceSnapshot(params: UpdateSnapshotParams): Snapshot {
    return this.request(() => {
      const previous = this.snapshot;
      const next = this.api.updateSnapshot(params);
      this.snapshot = next;
      if (previous) {
        try { previous.dispose(); }
        catch (error) { if (!isBadFileDescriptor(error)) throw error; }
      }
      return next;
    });
  }

  private request<T>(operation: () => T): T {
    try { return operation(); }
    catch (error) {
      if (!isBadFileDescriptor(error)) throw error;
      this.recover();
      try { return operation(); }
      catch (retryError) { throw new Ts7ServerDiedError(retryError); }
    }
  }

  private recover(): void {
    this.disposeSnapshot();
    try { this.api.close(); }
    catch (error) { if (!isBadFileDescriptor(error)) throw error; }
    this.api = this.createApi();
    if (this.configs.length > 0) this.snapshot = this.api.updateSnapshot({ openProjects: [...this.configs] });
  }

  private createApi(): API {
    return new API({ cwd: this.root, fs: { readFile: (file) => {
      if (!this.changed.has(path.resolve(file))) return undefined;
      try { return readFileSync(file, 'utf8'); }
      catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    } } });
  }

  private requireSnapshot(): Snapshot {
    if (!this.snapshot) throw new Error('TypeScript 7 projects have not been loaded.');
    return this.snapshot;
  }

  private disposeSnapshot(): void {
    if (!this.snapshot) return;
    try { this.snapshot.dispose(); }
    catch (error) { if (!isBadFileDescriptor(error)) throw error; }
    this.snapshot = undefined;
  }
}

export function isBadFileDescriptor(error: unknown): boolean {
  return error instanceof Error && (/\bEBADF\b|bad file descriptor|Unexpected EOF while reading from child process/i.test(error.message) || (error as NodeJS.ErrnoException).code === 'EPIPE');
}
