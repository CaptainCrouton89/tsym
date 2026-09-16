import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Project } from 'typescript/unstable/sync';
import { Ts7Host } from './api.js';

const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const skipped = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

export interface ConfiguredProject { config: string; files: ReadonlySet<string>; bootstrap: string | null; }

/** Discovers configured projects and applies the first-config ownership rule. */
export class ConfiguredProjects {
  private loaded = false;
  private projects = new Map<string, ConfiguredProject>();

  constructor(readonly root: string, readonly program: Ts7Host) {}

  load(): readonly ConfiguredProject[] {
    if (this.loaded) return [...this.projects.values()];
    const configs = discoverConfigs(this.root);
    const projects = this.program.load(configs);
    for (const config of configs) {
      const project = projects.find((candidate) => path.resolve(candidate.configFileName) === config);
      if (!project) continue;
      const files = new Set(project.rootFiles.map((file) => path.resolve(file)).filter((file) => workspaceSourceFile(this.root, file)));
      if (files.size === 0) continue;
      this.projects.set(config, { config, files, bootstrap: [...files].find((file) => sourceExtensions.has(path.extname(file))) ?? null });
    }
    this.loaded = true;
    if (this.projects.size === 0) throw new Error(`No configured TypeScript project exists under ${this.root}.`);
    return [...this.projects.values()];
  }

  /** Re-discovers configured projects after a workspace shape change. */
  reload(): readonly ConfiguredProject[] {
    this.loaded = false;
    this.projects.clear();
    return this.load();
  }

  membership(file: string): ConfiguredProject | null {
    this.load();
    const absolute = path.resolve(file);
    for (const project of this.projects.values()) if (project.files.has(absolute)) return project;
    return null;
  }

  refreshFile(file: string): void { this.program.update({ fileChanges: { changed: [path.resolve(file)] } }); }

  sourceFile(file: string) {
    const project = this.membership(file);
    return project ? this.program.sourceFile(project.config, path.resolve(file)) : undefined;
  }

  anySourceFile(file: string) { return this.program.sourceFile(undefined, path.resolve(file)); }

  records(): readonly ConfiguredProject[] { return [...this.projects.values()]; }
}

/** Every non-skipped directory in the workspace, including the root. */
export function discoverDirectories(root: string): string[] {
  const directories = [path.resolve(root)];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || skipped.has(entry.name)) continue;
      const full = path.resolve(dir, entry.name);
      directories.push(full);
      visit(full);
    }
  };
  visit(root);
  return directories;
}

export function discoverConfigs(root: string): string[] {
  const configs = discoverDirectories(root)
    .map((directory) => path.join(directory, 'tsconfig.json'))
    .filter((config) => statOrNull(config)?.isFile() === true);
  return configs.sort((left, right) => path.relative(root, left).localeCompare(path.relative(root, right)));
}

function statOrNull(file: string) {
  try { return statSync(file); }
  catch { return null; }
}

function workspaceSourceFile(root: string, file: string): boolean {
  if (!existsSync(file) || !sourceExtensions.has(path.extname(file))) return false;
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) && !relative.split(path.sep).some((part) => skipped.has(part));
}
