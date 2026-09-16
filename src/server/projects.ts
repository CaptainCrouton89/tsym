import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type { TsServerSession } from './tsserver.js';

const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);
const skipped = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

export interface ProjectRecord { config: string; files: ReadonlySet<string>; bootstrap: string | null; }

/** Registry of tsserver-reported configured projects. It never builds a Program or checker. */
export class ProjectRegistry {
  private loaded = false;
  private projects = new Map<string, ProjectRecord>();

  constructor(readonly root: string, readonly session: TsServerSession) {}

  async bootstrap(): Promise<readonly ProjectRecord[]> {
    if (this.loaded) return [...this.projects.values()];
    const compiler = compilerFor(this.session.location.path);
    for (const config of discoverConfigs(this.root)) {
      const candidate = candidateForConfig(config, compiler);
      if (!candidate) continue;
      await this.session.open(candidate);
      let retained = false;
      try {
        const info = await this.session.projectInfo(candidate);
        const reported = info.configFileName;
        if (!reported || reported === '/dev/null') continue;
        const config = path.resolve(reported);
        if (this.projects.has(config)) continue;
        const files = new Set((info.fileNames ?? []).map((file) => path.resolve(file)));
        // Keeps tsserver's configured project resident; registry owns its lifetime.
        this.projects.set(config, { config, files, bootstrap: candidate });
        retained = true;
      } finally {
        if (!retained) await this.session.close(candidate);
      }
    }
    this.loaded = true;
    if (this.projects.size === 0) throw new Error(`No configured TypeScript project exists under ${this.root}.`);
    return [...this.projects.values()];
  }

  async membership(file: string): Promise<ProjectRecord | null> {
    await this.bootstrap();
    const absolute = path.resolve(file);
    for (const project of this.projects.values()) if (project.files.has(absolute)) return project;
    return null;
  }

  records(): readonly ProjectRecord[] { return [...this.projects.values()]; }
}

function discoverConfigs(root: string): string[] {
  const configs: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (!skipped.has(entry.name)) visit(full); }
      else if (entry.isFile() && entry.name === 'tsconfig.json') configs.push(full);
    }
  };
  visit(root);
  return configs.sort();
}

function candidateForConfig(config: string, compiler: typeof import('typescript')): string | null {
  const read = compiler.readConfigFile(config, compiler.sys.readFile);
  if (read.error || !read.config) return null;
  const parsed = compiler.parseJsonConfigFileContent(read.config, compiler.sys, path.dirname(config), undefined, config);
  return parsed.fileNames.find((file) => sourceExtensions.has(path.extname(file)) && existsSync(file)) ?? null;
}

function compilerFor(tsserver: string): typeof import('typescript') { return createRequire(import.meta.url)(tsserver.replace(/tsserver\.js$/, 'typescript.js')) as typeof import('typescript'); }
