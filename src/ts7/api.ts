import { API, type Project, type Snapshot } from 'typescript/unstable/sync';
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

  constructor(readonly root: string) { this.api = new API({ cwd: root }); }

  load(configs: readonly string[]): readonly Project[] {
    this.configs = [...configs];
    return this.replaceSnapshot({ openProjects: [...this.configs] }).getProjects();
  }

  update(params: UpdateSnapshotParams): readonly Project[] {
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
      this.disposeSnapshot();
      const next = this.api.updateSnapshot(params);
      this.snapshot = next;
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
    this.api = new API({ cwd: this.root });
    if (this.configs.length > 0) this.snapshot = this.api.updateSnapshot({ openProjects: [...this.configs] });
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
