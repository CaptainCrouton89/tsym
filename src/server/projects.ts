import { Ts7Host } from '../ts7/api.js';
import { ConfiguredProjects } from '../ts7/projects.js';
import type { TsServerSession } from './tsserver.js';

export interface ProjectRecord { config: string; files: ReadonlySet<string>; bootstrap: string | null; }

const byTsserverPath = new Map<string, ProjectRegistry>();

/** Registry of configured TypeScript 7 projects, retaining tsserver documents for v1 consumers. */
export class ProjectRegistry {
  private readonly projects: ConfiguredProjects;
  private bootstrapped = false;

  constructor(readonly root: string, readonly session: TsServerSession, program: Ts7Host = new Ts7Host(root)) {
    this.projects = new ConfiguredProjects(root, program);
    byTsserverPath.set(session.location.path, this);
  }

  async bootstrap(): Promise<readonly ProjectRecord[]> {
    const records = this.projects.load();
    if (!this.bootstrapped) {
      for (const project of records) if (project.bootstrap) await this.session.open(project.bootstrap);
      this.bootstrapped = true;
    }
    return records;
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

export function registryForTsserverPath(tsserverPath: string): ProjectRegistry {
  const registry = byTsserverPath.get(tsserverPath);
  if (!registry) throw new Error(`No TypeScript 7 project registry exists for ${tsserverPath}.`);
  return registry;
}
