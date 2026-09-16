import { Ts7Host } from '../ts7/api.js';
import { ConfiguredProjects } from '../ts7/projects.js';

export interface ProjectRecord { config: string; files: ReadonlySet<string>; bootstrap: string | null; }

/** Registry of configured TypeScript 7 projects. */
export class ProjectRegistry {
  private readonly projects: ConfiguredProjects;
  private bootstrapped = false;

  constructor(readonly root: string, program: Ts7Host = new Ts7Host(root)) {
    this.projects = new ConfiguredProjects(root, program);
  }

  async bootstrap(): Promise<readonly ProjectRecord[]> {
    if (!this.bootstrapped) {
      this.projects.load();
      this.bootstrapped = true;
    }
    return this.projects.records();
  }

  async membership(file: string): Promise<ProjectRecord | null> {
    await this.bootstrap();
    return this.projects.membership(file);
  }

  refreshFile(file: string): void { this.projects.refreshFile(file); }

  sourceFile(file: string) { return this.projects.sourceFile(file); }

  anySourceFile(file: string) { return this.projects.anySourceFile(file); }

  records(): readonly ProjectRecord[] { return this.projects.records(); }

  configured(): ConfiguredProjects { return this.projects; }
}
